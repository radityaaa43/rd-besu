import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Interface, Wallet, getBytes, hexlify, isAddress, isHexString } from 'ethers';
import { CERTIFICATE_LENGTH, parseBondMetadata, payloadWithoutCertificate, signCertificate } from '../../ts/bond.ts';
import { TRANCHE_A, biRows, pay, read } from '../../ts/chain.ts';
import { metaAddressOf, scan } from '../../ts/stealth.ts';
import { parseTokenMetadata } from '../../ts/token.ts';
import { PARTIES, compareViewKeys } from './compare.ts';
import { TERMS_TUPLE, termsTuple } from './chainPort.ts';
import type { BankKeys, BiKeys, CustodianKeys, Leg, SignerConfig, SignerDeps, Terms } from './types.ts';

// ABIs inline (analyst verdict 2): the image has no forge output. Signatures: src/RupiahDigital.sol, src/DfabiBond.sol, ERC1400.
const rdAbi = new Interface([
  'function sendStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)',
  'function transfer(address to, uint256 amount)',
  'function mintStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)',
]);
const bondAbi = new Interface([
  'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo, bytes data)',
  'function transferByPartition(bytes32 partition, address to, uint256 value, bytes data)',
  'function issueByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)',
]);
const factoryAbi = new Interface([`function create(${TERMS_TUPLE} t, bytes settleCert, bytes refundCert) returns (address)`]); // src/DvPFactory.sol:30
const escrowAbi = new Interface(['function settle()', 'function cancel()']); // src/DvPEscrow.sol:108, :129
const SEL_STEALTH = bondAbi.getFunction('transferByPartitionStealth')!.selector;
const SEL_PLAIN = bondAbi.getFunction('transferByPartition')!.selector;

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_BODY = 64 * 1024;
const MAX_COPY_BODY = 4096; // a view-key copy is ~300 bytes
const COPY_IDS = PARTIES.filter((p) => p !== 'bi'); // the slots a bank may push: bank-a, bank-b, bank-c

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new HttpError(413, 'body_too_large');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, 'bad_json', 'body is not a JSON object');
  }
}

const isLeg = (l: any): l is Leg => !!l && isAddress(l.receiver) && isHexString(l.ephemeralPubKey) && isHexString(l.viewTag, 1) && isHexString(l.memo);
const legOf = (p: ReturnType<typeof pay>): Leg => ({ receiver: p.s.stealthAddress, ephemeralPubKey: p.s.ephemeralPubKey, viewTag: p.s.viewTag, memo: p.memo });

function parseAmount(v: unknown): bigint {
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) throw new HttpError(422, 'bad_amount', 'amount must be a decimal string');
  const n = BigInt(v);
  if (n < 1n || n > MAX_UINT256) throw new HttpError(422, 'bad_amount', 'amount out of range 1..2^256-1');
  return n;
}

// Returns an http.Server that is not listening yet. One instance serves one party; keys stay in this closure.
export function createSigner(cfg: SignerConfig, deps: SignerDeps): Server {
  const { keys, chain, log } = deps;
  const ttl = BigInt(cfg.certTtlSeconds ?? 600);
  const names = Object.keys(keys).sort().join(',');
  if (cfg.role === 'custodian' && names !== 'certKey') throw new Error(`role custodian needs keys {certKey} and no bank key, got {${names}}`);
  if (cfg.role === 'bank' && names !== 'identityKey,spendKey,viewKey') throw new Error(`role bank needs keys {identityKey,spendKey,viewKey} and no certKey, got {${names}}`);
  if (cfg.role === 'bi' && names !== 'issuerKey,spendKey,viewCopies,viewKey') throw new Error(`role bi needs keys {issuerKey,spendKey,viewKey,viewCopies} and no certKey, got {${names}}`);
  const bi = keys as BiKeys; // only dereferenced on role bi routes
  // role bi acts as a bank for holdings/history/meta-address with its own receive keys; its identity account is the issuer key (as in the Lensa adapter).
  const bank = (cfg.role === 'bi' ? { spendKey: bi.spendKey, viewKey: bi.viewKey, identityKey: bi.issuerKey } : keys) as BankKeys;
  const certKey = (keys as CustodianKeys).certKey;

  // Live 2026-11-13: a full EC scan per request blocked the event loop (BI signer killed by its liveness probe). Announcements are append-only
  // (QBFT final, chainPort caches the logs), so each is scanned once; the scan yields every SCAN_CHUNK announcements so /health still answers.
  const SCAN_CHUNK = 25;
  const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
  async function chunked<T, R>(items: T[], f: (part: T[]) => R[]): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += SCAN_CHUNK) { out.push(...f(items.slice(i, i + SCAN_CHUNK))); await yieldLoop(); }
    return out;
  }
  type Mine = { found: ReturnType<typeof scan>[number]; ann: Awaited<ReturnType<typeof chain.announcements>>[number]; token: string; kind: 'bond' | 'rd'; partition: string | null };
  const mineCache = { n: 0, out: [] as Mine[] };
  // Everything this party owns, from its own RPC: scan() result joined with its announcement.
  async function mine() {
    const anns = await chain.announcements(cfg.fromBlock);
    if (anns.length < mineCache.n) { mineCache.n = 0; mineCache.out = []; } // the log source was reset: start over
    const fresh = anns.slice(mineCache.n);
    const found = await chunked(fresh, (part) => scan(part, bank.viewKey, bank.spendKey));
    mineCache.out = [...mineCache.out, ...found.flatMap((f): Mine[] => {
      const ann = fresh.find((a) => sameAddr(a.stealthAddress, f.stealthAddress))!;
      const bond = parseBondMetadata(ann.metadata);
      const rd = bond ? null : parseTokenMetadata(ann.metadata);
      const m = bond ?? rd;
      const token = m && (sameAddr(m.token, cfg.rd) ? cfg.rd : sameAddr(m.token, cfg.bond) ? cfg.bond : null);
      if (!m || !token) return []; // not a payment in RD or the bond: ignore
      return [{ found: f, ann, token, kind: (bond ? 'bond' : 'rd') as 'bond' | 'rd', partition: bond ? bond.partition : null }];
    })];
    mineCache.n = anns.length;
    return mineCache.out;
  }

  // Balances move, so they are read every time; in parallel batches (one eth_call per holding through the own bank-gw door).
  async function holdings() {
    const hs = await mine();
    const out: (Mine & { amount: bigint })[] = [];
    for (let i = 0; i < hs.length; i += 10) {
      const part = hs.slice(i, i + 10);
      const amounts = await Promise.all(part.map((h) => chain.balanceOf(h.token, h.found.stealthAddress, h.partition ?? undefined)));
      part.forEach((h, j) => out.push({ ...h, amount: amounts[j]! }));
    }
    return out;
  }

  // One address, one transfer (verdict 5): the first holding that covers the amount, or exactly `source` when given.
  async function pick(token: string, partition: string | undefined, amount: bigint, source?: string) {
    for (const h of await holdings()) {
      if (source !== undefined && !sameAddr(h.found.stealthAddress, source)) continue;
      if (sameAddr(h.token, token) && (partition === undefined || h.partition === partition) && h.amount >= amount) return h.found;
    }
    throw new HttpError(422, 'insufficient_holdings', 'no single holding covers the amount');
  }

  // S17 DvP, seller or buyer side: the holding this party will fund from, and the leg it pays to the counterparty's meta-address (sender = own identity key).
  // ponytail: no reservation between offer and dvp-leg; Lensa runs one trade at a time. Reserve per tradeId if trades ever overlap.
  async function quote(side: 'offer' | 'bid', body: any) {
    const amount = parseAmount(side === 'offer' ? body.amount : body.price);
    const token = side === 'offer' ? cfg.bond : cfg.rd;
    const partition = side === 'offer' ? TRANCHE_A : undefined;
    let p: ReturnType<typeof pay>;
    try { p = pay(cfg.chainId, side === 'offer' ? body.buyerMeta : body.sellerMeta, bank.identityKey, token, amount, partition); }
    catch { throw new HttpError(422, 'bad_meta_address', 'meta-address is not valid'); }
    const src = await pick(token, partition, amount);
    return side === 'offer'
      ? { status: 200, body: { tradeId: body.tradeId, seller: src.stealthAddress, bondLeg: legOf(p) } }
      : { status: 200, body: { tradeId: body.tradeId, buyer: src.stealthAddress, rdLeg: legOf(p) } };
  }

  function parseTerms(b: any): Omit<Terms, 'bond' | 'rd' | 'partition' | 'expiry' | 'refundWindow'> {
    if (!(typeof b.tradeId === 'string' && isHexString(b.tradeId, 32)) || !isAddress(b.seller) || !isAddress(b.buyer) || !isLeg(b.bondLeg) || !isLeg(b.rdLeg)) {
      throw new HttpError(422, 'bad_request', 'tradeId, seller, buyer, bondLeg, rdLeg required');
    }
    const leg = (l: Leg): Leg => ({ receiver: l.receiver, ephemeralPubKey: l.ephemeralPubKey, viewTag: l.viewTag, memo: l.memo });
    return { tradeId: b.tradeId, seller: b.seller, buyer: b.buyer, bondAmount: parseAmount(b.bondAmount).toString(), rdAmount: parseAmount(b.rdAmount).toString(), bondLeg: leg(b.bondLeg), rdLeg: leg(b.rdLeg) };
  }

  // BI signer: the issuer account is DvPFactory.custodian (immutable). BI fixes token addresses, expiry and refund window; the custodian signs the certs.
  async function escrow(body: any) {
    if (cfg.role !== 'bi') throw new HttpError(403, 'role_forbidden', 'escrows are created by the BI signer only');
    if (!cfg.dvpFactory) throw new HttpError(502, 'rpc_error', 'no DvP factory configured');
    const t: Terms = { ...parseTerms(body), bond: cfg.bond, rd: cfg.rd, partition: TRANCHE_A, expiry: ((await chain.now()) + ttl).toString(), refundWindow: ttl.toString() };
    if (!deps.cert?.escrowCerts) throw new HttpError(502, 'cert_unavailable', 'no custodian configured');
    let c: { settleCert: string; refundCert: string };
    try { c = await deps.cert.escrowCerts(t); } catch { throw new HttpError(502, 'cert_unavailable', 'custodian refused or unreachable'); }
    const at = await chain.predictEscrow(t);
    const data = factoryAbi.encodeFunctionData('create', [termsTuple(t), c.settleCert, c.refundCert]);
    const issuer = new Wallet(bi.issuerKey);
    const [nonce, gasPrice, gasLimit] = await Promise.all([chain.nonce(issuer.address), chain.gasPrice(), chain.estimateGas({ from: issuer.address, to: cfg.dvpFactory, data })]);
    const rawTx = await issuer.signTransaction({ type: 0, chainId: cfg.chainId, nonce, gasPrice, gasLimit, to: cfg.dvpFactory, data, value: 0n });
    const txHash = await chain.sendRawTransaction(rawTx);
    return { status: 200, body: { escrow: at, expiry: t.expiry, txHash, terms: t }, note: `escrow=${at} tx=${txHash}` };
  }

  // Custodian: settle + refund certificates for the escrow of these terms. The escrow address comes from DvPFactory.predict on chain, never from the caller.
  async function escrowCerts(req: IncomingMessage) {
    if (cfg.role !== 'custodian') throw new HttpError(403, 'role_forbidden', '/escrow-certs is served by the custodian only');
    const peer = deps.peer?.(req);
    if (!peer || !cfg.biSigner || peer.subject !== cfg.biSigner) {
      log(`escrow-certs refused requester=${peer?.subject ?? 'none'} reason=not_bi_signer`);
      throw new HttpError(403, 'not_bi_signer', 'client certificate is not the BI signer');
    }
    const b: any = await readBody(req);
    const base = parseTerms(b);
    if (!isAddress(b.bond) || !sameAddr(b.bond, cfg.bond) || !isAddress(b.rd) || !sameAddr(b.rd, cfg.rd)) throw new HttpError(422, 'bad_token', 'bond or rd is not ours');
    if (!(typeof b.partition === 'string' && isHexString(b.partition, 32))) throw new HttpError(422, 'bad_request', 'partition must be 32 bytes hex');
    if (typeof b.expiry !== 'string' || !/^[0-9]+$/.test(b.expiry) || typeof b.refundWindow !== 'string' || !/^[0-9]+$/.test(b.refundWindow)) throw new HttpError(422, 'bad_request', 'expiry and refundWindow required');
    const expiry = BigInt(b.expiry);
    if (expiry > (await chain.now()) + ttl) throw new HttpError(422, 'bad_expiry', 'expiry too far ahead');
    if (BigInt(b.refundWindow) !== ttl) throw new HttpError(422, 'bad_request', 'refundWindow must equal the certificate ttl');
    const t: Terms = { ...base, bond: cfg.bond, rd: cfg.rd, partition: b.partition, expiry: b.expiry, refundWindow: b.refundWindow };
    const escrowAddr = await chain.predictEscrow(t);
    const zero = hexlify(new Uint8Array(CERTIFICATE_LENGTH));
    const [domainSeparator, nonce] = await Promise.all([chain.bondDomainSeparator(), chain.usedCertificateNonce(cfg.bond, escrowAddr)]);
    const sign = (data: string, exp: bigint) => signCertificate(certKey, { domainSeparator, msgSender: escrowAddr, token: cfg.bond, payload: payloadWithoutCertificate(data), expiry: exp, nonce });
    const bondAmount = BigInt(t.bondAmount);
    const settleCert = sign(bondAbi.encodeFunctionData('transferByPartitionStealth', [t.partition, t.bondLeg.receiver, bondAmount, t.bondLeg.ephemeralPubKey, t.bondLeg.viewTag, t.bondLeg.memo, zero]), expiry);
    const refundCert = sign(bondAbi.encodeFunctionData('transferByPartition', [t.partition, t.seller, bondAmount, zero]), expiry + ttl);
    log(`escrow-certs requester=${peer.subject} escrow=${escrowAddr}`);
    return { status: 200, body: { escrow: escrowAddr, settleCert, refundCert }, note: `escrow=${escrowAddr}` };
  }

  // Anyone may settle (DvPEscrow.settle) or, from expiry on, cancel (refund: RD to the buyer, bond to the seller with the stored refund cert, valid
  // expiry + refundWindow); a throwaway key signs it so no party key is tied to the trade on chain.
  async function settle(body: any, fn: 'settle' | 'cancel' = 'settle') {
    if (!isAddress(body.escrow)) throw new HttpError(422, 'bad_request', 'escrow must be an address');
    const w = Wallet.createRandom();
    const data = escrowAbi.encodeFunctionData(fn);
    const [nonce, gasPrice, gasLimit] = await Promise.all([chain.nonce(w.address), chain.gasPrice(), chain.estimateGas({ from: w.address, to: body.escrow, data })]);
    const rawTx = await w.signTransaction({ type: 0, chainId: cfg.chainId, nonce, gasPrice, gasLimit, to: body.escrow, data, value: 0n });
    const txHash = await chain.sendRawTransaction(rawTx);
    return { status: 200, body: { escrow: body.escrow, txHash }, note: `${fn} tx=${txHash}` };
  }

  async function intent(body: any) {
    if (body.from !== cfg.party) throw new HttpError(403, 'wrong_party', 'intent is for another party');
    const kind = body.kind;
    if (kind !== 'rd-transfer' && kind !== 'bond-transfer' && kind !== 'dvp-leg' && kind !== 'rd-mint' && kind !== 'bond-issue') throw new HttpError(422, 'unknown_kind');
    if ((kind === 'rd-mint' || kind === 'bond-issue') && cfg.role !== 'bi') throw new HttpError(403, 'role_forbidden', 'only the BI signer mints or issues');
    const amount = parseAmount(body.amount);

    // Issuer calls: signed by the issuer ACCOUNT (not a stealth address), no holding to spend, no certificate (the minter is exempt). No cert or controller op is
    // ever signed with this key here (analyst Q12): /cert stays custodian-only.
    if (kind === 'rd-mint' || kind === 'bond-issue') {
      const token = kind === 'rd-mint' ? cfg.rd : cfg.bond;
      const partition = kind === 'bond-issue' ? (body.partition ?? TRANCHE_A) : undefined;
      if (partition !== undefined && !(typeof partition === 'string' && isHexString(partition, 32))) throw new HttpError(422, 'bad_request', 'partition must be 32 bytes hex');
      let p: ReturnType<typeof pay>;
      try { p = pay(cfg.chainId, body?.to?.metaAddress, bi.issuerKey, token, amount, partition); }
      catch { throw new HttpError(422, 'bad_meta_address', 'meta-address is not valid'); }
      const data = kind === 'rd-mint'
        ? rdAbi.encodeFunctionData('mintStealth', [p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo])
        : bondAbi.encodeFunctionData('issueByPartitionStealth', [partition, p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo]);
      const issuer = new Wallet(bi.issuerKey);
      const [nonce, gasPrice, gasLimit] = await Promise.all([chain.nonce(issuer.address), chain.gasPrice(), chain.estimateGas({ from: issuer.address, to: token, data })]);
      const rawTx = await issuer.signTransaction({ type: 0, chainId: cfg.chainId, nonce, gasPrice, gasLimit, to: token, data, value: 0n });
      const txHash = await chain.sendRawTransaction(rawTx);
      return { status: 200, body: { kind, from: issuer.address, txHash, rawTx }, note: `tx=${txHash}` };
    }

    // What to send: token + partition the funds must sit in, and a builder for the calldata (cert is the last bond argument).
    let token: string, partition: string | undefined, build: (cert?: string) => string;
    if (kind === 'dvp-leg') {
      if (!isAddress(body.escrow)) throw new HttpError(422, 'bad_request', 'escrow must be an address');
      if (body.leg === 'bond') {
        token = cfg.bond; partition = TRANCHE_A;
        build = (cert = hexlify(new Uint8Array(CERTIFICATE_LENGTH))) => bondAbi.encodeFunctionData('transferByPartition', [TRANCHE_A, body.escrow, amount, cert]);
      } else if (body.leg === 'rd') {
        token = cfg.rd;
        build = () => rdAbi.encodeFunctionData('transfer', [body.escrow, amount]);
      } else throw new HttpError(422, 'bad_request', 'leg must be bond or rd');
    } else {
      if (kind === 'bond-transfer' && body.partition !== undefined && !(typeof body.partition === 'string' && isHexString(body.partition, 32))) {
        throw new HttpError(422, 'bad_request', 'partition must be 32 bytes hex');
      }
      token = kind === 'rd-transfer' ? cfg.rd : cfg.bond;
      partition = kind === 'bond-transfer' ? (body.partition ?? TRANCHE_A) : undefined;
      let p: ReturnType<typeof pay>;
      try { p = pay(cfg.chainId, body?.to?.metaAddress, bank.identityKey, token, amount, partition); }
      catch { throw new HttpError(422, 'bad_meta_address', 'meta-address is not valid'); }
      build = kind === 'rd-transfer'
        ? () => rdAbi.encodeFunctionData('sendStealth', [p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo])
        : (cert = hexlify(new Uint8Array(CERTIFICATE_LENGTH))) =>
            bondAbi.encodeFunctionData('transferByPartitionStealth', [partition, p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo, cert]);
    }

    // dvp-leg names the holding it offered (/dvp/offer, /dvp/bid): the escrow refunds to that address, so the funds must come from it.
    if (kind === 'dvp-leg' && body.source !== undefined && !isAddress(body.source)) throw new HttpError(422, 'bad_request', 'source must be an address');
    const spender = await pick(token, partition, amount, kind === 'dvp-leg' ? body.source : undefined);

    let data = build();
    if (token === cfg.bond) {
      // The custodian signs the call minus the certificate; the real certificate must be in place before estimateGas.
      if (!deps.cert) throw new HttpError(502, 'cert_unavailable', 'no custodian configured');
      let certificate: string;
      try {
        certificate = await deps.cert.request({
          sender: spender.stealthAddress, token, payload: payloadWithoutCertificate(data), expiry: (await chain.now()) + ttl,
        });
      } catch { throw new HttpError(502, 'cert_unavailable', 'custodian refused or unreachable'); }
      data = build(certificate);
    }
    const [nonce, gasPrice, gasLimit] = await Promise.all([
      chain.nonce(spender.stealthAddress), chain.gasPrice(), chain.estimateGas({ from: spender.stealthAddress, to: token, data }),
    ]);
    const rawTx = await new Wallet(spender.privateKey).signTransaction({ type: 0, chainId: cfg.chainId, nonce, gasPrice, gasLimit, to: token, data, value: 0n });
    const txHash = await chain.sendRawTransaction(rawTx);
    return { status: 200, body: { kind, from: spender.stealthAddress, txHash, rawTx }, note: `tx=${txHash}` };
  }

  const readCache = new Map<string, { amount: string; sender: string | null }>(); // memo decryption once per received payment
  async function history() {
    const rows = [];
    for (const h of await mine()) {
      const key = `${h.ann.txHash}:${h.found.stealthAddress}`.toLowerCase();
      let r = readCache.get(key);
      if (!r) { const x = read(cfg.chainId, h.ann, bank.viewKey, h.kind); r = { amount: x.amount.toString(), sender: x.sender }; readCache.set(key, r); }
      rows.push({ txHash: h.ann.txHash, blockNumber: h.ann.blockNumber, stealthAddress: h.found.stealthAddress, token: h.token, amount: r.amount, sender: r.sender, partition: h.partition });
    }
    return rows;
  }

  // BI's detective view (S10, DELTA 3): every payment resolved to a bank by that bank's VIEW-key copy, with amount and authenticated sender. Never a spend key.
  // Per kind: rows of the announcements already scanned with THIS view-copy set; a changed set (PUT /viewcopy) rescans from the start.
  type LedgerRow = { bank: string; amount: string; sender: string | null; tx: string; blockNumber: number | null };
  const ledgerCache = new Map<string, { copies: string; n: number; rows: LedgerRow[] }>();
  async function ledger(kind: 'rd' | 'bond') {
    const token = kind === 'rd' ? cfg.rd : cfg.bond;
    const all = await chain.announcements(cfg.fromBlock);
    const copies = JSON.stringify(bi.viewCopies.map((c) => [c.id, c.metaAddress, c.viewKey.length]));
    let c = ledgerCache.get(kind);
    if (!c || c.copies !== copies || all.length < c.n) c = { copies, n: 0, rows: [] };
    const fresh = all.slice(c.n).filter((a) => {
      const bond = parseBondMetadata(a.metadata);
      const m = bond ?? parseTokenMetadata(a.metadata);
      return m && (kind === 'bond') === !!bond && sameAddr(m.token, token);
    });
    const block = new Map(fresh.map((a) => [a.txHash.toLowerCase(), a.blockNumber]));
    const viewCopies = bi.viewCopies;
    const rows = await chunked(fresh, (part) => biRows(cfg.chainId, part, viewCopies, kind).map((r) => ({ bank: r.bank, amount: r.amount.toString(), sender: r.sender, tx: r.tx, blockNumber: block.get(String(r.tx).toLowerCase()) ?? null })));
    c = { copies, n: all.length, rows: [...c.rows, ...rows] };
    ledgerCache.set(kind, c);
    return c.rows;
  }

  // S11 rework: a bank pushes ITS OWN view-key copy (never a spend key) through BI's gateway; OPA already limited the caller to its own slot. Validate, check against the
  // ERC-6538 registry (same rule as the compare job), write the Secret FIRST, then update the in-memory copies. The body is never logged or echoed.
  const identities = new Map<string, string>(); // identity address of each copy pushed since start (the copies loaded from disk carry none)
  async function viewCopy(id: string, body: Record<string, unknown>) {
    const { viewKey, metaAddress, identityAddress } = body;
    if (Object.keys(body).length !== 3 || typeof viewKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(viewKey) || typeof metaAddress !== 'string' || !/^0x[0-9a-fA-F]{132}$/.test(metaAddress)
      || typeof identityAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(identityAddress) || !isAddress(identityAddress)) throw new HttpError(422, 'bad_body', 'viewKey, metaAddress and identityAddress required, nothing else');
    const row = (await compareViewKeys({ registry: (i) => chain.registryMetaAddress(i), banks: [{ id, viewKey, metaAddress, identityAddress }] })).find((r) => r.bank === id)!;
    if (row.status === 'bad_copy') throw new HttpError(422, 'bad_copy', 'view key does not belong to the meta-address');
    if (row.status === 'unregistered') throw new HttpError(422, 'unregistered', 'no meta-address registered under the identity address');
    if (row.status === 'MISMATCH') throw new HttpError(422, 'mismatch', 'registered viewing key differs from the pushed copy');
    if (row.status !== 'OK') throw new Error('registry read failed'); // generic 502, no cause echoed
    const cur = bi.viewCopies.find((c) => c.id === id);
    if (cur && cur.viewKey === viewKey && cur.metaAddress === metaAddress && identities.get(id) === identityAddress) return { status: 200, body: { id, status: 'unchanged' }, note: `viewcopy=${id}` };
    if (!deps.viewCopyStore) throw new HttpError(502, 'store_error', 'no view copy store configured');
    try { await deps.viewCopyStore.put(id, { viewKey, metaAddress, identityAddress }); }
    catch { throw new HttpError(502, 'store_error', 'view copy store write failed'); } // never echo the cause
    bi.viewCopies = [...bi.viewCopies.filter((c) => c.id !== id), { id, viewKey, metaAddress }].sort((a, b) => (a.id < b.id ? -1 : 1));
    identities.set(id, identityAddress);
    return { status: 200, body: { id, status: 'stored' }, note: `viewcopy=${id}` };
  }

  // Custodian: sign only what the rules (a)-(d) of the analyst verdict allow. Nonce and domain come from the chain.
  async function cert(req: IncomingMessage) {
    if (cfg.role !== 'custodian') throw new HttpError(403, 'role_forbidden', '/cert is served by the custodian only');
    const peer = deps.peer?.(req);
    if (!peer || !cfg.bankSigners?.includes(peer.subject)) {
      log(`cert refused requester=${peer?.subject ?? 'none'} reason=not_registered_signer`);
      throw new HttpError(403, 'not_registered_signer', 'client certificate is not a registered bank signer');
    }
    const b: any = await readBody(req);
    if (!isAddress(b.sender) || !isAddress(b.token) || typeof b.payload !== 'string' || !isHexString(b.payload)
      || typeof b.expiry !== 'string' || !/^[0-9]+$/.test(b.expiry)) throw new HttpError(422, 'bad_request', 'sender, token, payload, expiry required');
    const payload = getBytes(b.payload);
    const selector = payload.length >= 4 ? hexlify(payload.slice(0, 4)) : '0x';
    log(`cert request requester=${peer.subject} sender=${b.sender} token=${b.token} selector=${selector}`);
    if (!sameAddr(b.token, cfg.bond)) throw new HttpError(422, 'bad_token', 'token is not the bond');
    const expiry = BigInt(b.expiry);
    if (expiry > (await chain.now()) + ttl) throw new HttpError(422, 'bad_expiry', 'expiry too far ahead');
    let allowed = selector === SEL_STEALTH;
    if (selector === SEL_PLAIN && payload.length >= 68) allowed = await chain.isEscrow(hexlify(payload.slice(48, 68))); // `to` word of transferByPartition
    if (!allowed) throw new HttpError(422, 'selector_not_allowed', 'call is not on the allowlist');
    const certificate = signCertificate(certKey, {
      domainSeparator: await chain.bondDomainSeparator(), msgSender: b.sender, token: cfg.bond, payload: b.payload, expiry,
      nonce: await chain.usedCertificateNonce(cfg.bond, b.sender),
    });
    return { status: 200, body: { certificate }, note: `selector=${selector}` };
  }

  let queue: Promise<unknown> = Promise.resolve(); // ponytail: one intent at a time (nonce + one-holding reuse); per-address locks if throughput matters

  async function route(req: IncomingMessage) {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    const r = `${req.method} ${pathname}`;
    if (r === 'GET /health') return { status: 200, body: { ok: true } };
    if (cfg.role === 'custodian' && ['GET /holdings', 'GET /history', 'GET /meta-address', 'GET /ledger', 'POST /intent', 'POST /dvp/offer', 'POST /dvp/bid', 'POST /dvp/escrow', 'POST /dvp/settle', 'POST /dvp/cancel'].includes(r)) throw new HttpError(403, 'role_forbidden', 'the custodian holds no spend/view key');
    if (r === 'GET /holdings') {
      const hs = await holdings();
      return { status: 200, body: { party: cfg.party, holdings: hs.map((h) => ({ stealthAddress: h.found.stealthAddress, token: h.token, amount: h.amount.toString(), partition: h.partition })) } };
    }
    // public data only: the meta-address (spend + view PUBLIC keys) and the identity ACCOUNT address, the ERC-6538 registry key (PLAN S9 proof)
    if (r === 'GET /meta-address') return { status: 200, body: {
      party: cfg.party, metaAddress: metaAddressOf(bank.spendKey, bank.viewKey), identityAddress: new Wallet(bank.identityKey).address,
      contracts: { rd: cfg.rd, bond: cfg.bond, announcer: cfg.announcer ?? null, dvpFactory: cfg.dvpFactory ?? null }, // public addresses (Lensa trace labels)
    } };
    if (r === 'GET /ledger') {
      if (cfg.role !== 'bi') throw new HttpError(403, 'role_forbidden', 'the ledger view is the BI signer\'s');
      const kind = new URL(req.url ?? '/', 'http://x').searchParams.get('kind');
      if (kind !== 'rd' && kind !== 'bond') throw new HttpError(422, 'bad_request', 'kind must be rd or bond');
      return { status: 200, body: { kind, rows: await ledger(kind) } };
    }
    if (r === 'GET /history') return { status: 200, body: { party: cfg.party, history: await history() } };
    if (req.method === 'PUT' && pathname.startsWith('/viewcopy/')) {
      if (cfg.role !== 'bi') throw new HttpError(403, 'role_forbidden', 'view copies are stored by the BI signer only');
      const id = pathname.slice('/viewcopy/'.length);
      if (!COPY_IDS.includes(id)) throw new HttpError(404, 'not_found');
      const body = (await readBody(req, MAX_COPY_BODY)) as Record<string, unknown>;
      const run = queue.then(() => viewCopy(id, body));
      queue = run.catch(() => undefined);
      return run;
    }
    if (r === 'POST /intent') {
      const body = await readBody(req);
      const run = queue.then(() => intent(body));
      queue = run.catch(() => undefined);
      const out = await run;
      return { ...out, note: `kind=${(body as any).kind} ${out.note}` };
    }
    if (r === 'POST /cert') return cert(req);
    if (r === 'POST /escrow-certs') return escrowCerts(req);
    const serial = (f: (b: any) => Promise<any>) => async () => { const body = await readBody(req); const run = queue.then(() => f(body)); queue = run.catch(() => undefined); return run; };
    if (r === 'POST /dvp/offer') return serial((b) => quote('offer', b))();
    if (r === 'POST /dvp/bid') return serial((b) => quote('bid', b))();
    if (r === 'POST /dvp/escrow') return serial(escrow)();
    if (r === 'POST /dvp/settle') return serial((b) => settle(b))();
    if (r === 'POST /dvp/cancel') return serial((b) => settle(b, 'cancel'))();
    throw new HttpError(404, 'not_found');
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let status: number, body: unknown, note: string | undefined;
    try {
      ({ status, body, note } = (await route(req)) as { status: number; body: unknown; note?: string });
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; body = { error: e.code, message: e.message }; }
      else { status = 502; body = { error: 'rpc_error', message: 'own RPC call failed' }; note = `err=${(e as Error).name}`; } // never echo the cause: it may carry calldata
    }
    // ponytail: log only route, status and tx/selector. No error cause (could hold calldata); add it if debugging needs it, minus keys.
    log(`${req.method} ${(req.url ?? '').split('?')[0]} -> ${status}${note ? ' ' + note : ''}${(body as any)?.error ? ' ' + (body as any).error : ''}`);
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
}
