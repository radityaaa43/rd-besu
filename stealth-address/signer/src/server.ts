import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Interface, Wallet, getBytes, hexlify, isAddress, isHexString } from 'ethers';
import { CERTIFICATE_LENGTH, parseBondMetadata, payloadWithoutCertificate, signCertificate } from '../../ts/bond.ts';
import { TRANCHE_A, pay, read } from '../../ts/chain.ts';
import { metaAddressOf, scan } from '../../ts/stealth.ts';
import { parseTokenMetadata } from '../../ts/token.ts';
import type { BankKeys, CustodianKeys, SignerConfig, SignerDeps } from './types.ts';

// ABIs inline (analyst verdict 2): the image has no forge output. Signatures: src/RupiahDigital.sol, src/DfabiBond.sol, ERC1400.
const rdAbi = new Interface([
  'function sendStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)',
  'function transfer(address to, uint256 amount)',
]);
const bondAbi = new Interface([
  'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo, bytes data)',
  'function transferByPartition(bytes32 partition, address to, uint256 value, bytes data)',
]);
const SEL_STEALTH = bondAbi.getFunction('transferByPartitionStealth')!.selector;
const SEL_PLAIN = bondAbi.getFunction('transferByPartition')!.selector;

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function readBody(req: IncomingMessage): Promise<unknown> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(413, 'body_too_large');
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
  const bank = keys as BankKeys; // only dereferenced on role bank routes
  const certKey = (keys as CustodianKeys).certKey;

  // Everything this party owns, from its own RPC: scan() result joined with its announcement.
  async function mine() {
    const anns = await chain.announcements(cfg.fromBlock);
    return scan(anns, bank.viewKey, bank.spendKey).flatMap((f) => {
      const ann = anns.find((a) => sameAddr(a.stealthAddress, f.stealthAddress))!;
      const bond = parseBondMetadata(ann.metadata);
      const rd = bond ? null : parseTokenMetadata(ann.metadata);
      const m = bond ?? rd;
      const token = m && (sameAddr(m.token, cfg.rd) ? cfg.rd : sameAddr(m.token, cfg.bond) ? cfg.bond : null);
      if (!m || !token) return []; // not a payment in RD or the bond: ignore
      return [{ found: f, ann, token, kind: (bond ? 'bond' : 'rd') as 'bond' | 'rd', partition: bond ? bond.partition : null }];
    });
  }

  async function holdings() {
    const out = [];
    for (const h of await mine()) {
      const amount = await chain.balanceOf(h.token, h.found.stealthAddress, h.partition ?? undefined);
      out.push({ ...h, amount });
    }
    return out;
  }

  async function intent(body: any) {
    if (body.from !== cfg.party) throw new HttpError(403, 'wrong_party', 'intent is for another party');
    const kind = body.kind;
    if (kind !== 'rd-transfer' && kind !== 'bond-transfer' && kind !== 'dvp-leg') throw new HttpError(422, 'unknown_kind');
    const amount = parseAmount(body.amount);

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

    // One address, one transfer (verdict 5): the first holding that covers the amount.
    let spender: { stealthAddress: string; privateKey: string } | undefined;
    for (const h of await holdings()) {
      if (sameAddr(h.token, token) && (partition === undefined || h.partition === partition) && h.amount >= amount) { spender = h.found; break; }
    }
    if (!spender) throw new HttpError(422, 'insufficient_holdings', 'no single holding covers the amount');

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

  async function history() {
    const rows = [];
    for (const h of await mine()) {
      const r = read(cfg.chainId, h.ann, bank.viewKey, h.kind);
      rows.push({ txHash: h.ann.txHash, blockNumber: h.ann.blockNumber, stealthAddress: h.found.stealthAddress, token: h.token, amount: r.amount.toString(), sender: r.sender });
    }
    return rows;
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
    if (cfg.role === 'custodian' && ['GET /holdings', 'GET /history', 'GET /meta-address', 'POST /intent'].includes(r)) throw new HttpError(403, 'role_forbidden', 'the custodian holds no spend/view key');
    if (r === 'GET /holdings') {
      const hs = await holdings();
      return { status: 200, body: { party: cfg.party, holdings: hs.map((h) => ({ stealthAddress: h.found.stealthAddress, token: h.token, amount: h.amount.toString(), partition: h.partition })) } };
    }
    // public data only: the meta-address (spend + view PUBLIC keys) and the identity ACCOUNT address, the ERC-6538 registry key (PLAN S9 proof)
    if (r === 'GET /meta-address') return { status: 200, body: { party: cfg.party, metaAddress: metaAddressOf(bank.spendKey, bank.viewKey), identityAddress: new Wallet(bank.identityKey).address } };
    if (r === 'GET /history') return { status: 200, body: { party: cfg.party, history: await history() } };
    if (r === 'POST /intent') {
      const body = await readBody(req);
      const run = queue.then(() => intent(body));
      queue = run.catch(() => undefined);
      const out = await run;
      return { ...out, note: `kind=${(body as any).kind} ${out.note}` };
    }
    if (r === 'POST /cert') return cert(req);
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
