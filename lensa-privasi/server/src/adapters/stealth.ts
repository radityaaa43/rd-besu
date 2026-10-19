import { randomBytes } from 'node:crypto';
import type { Capability, Counterparty, FlowResult, LensView, ModelAdapter, StepEvent } from '../adapter.ts';
import { CANCELLED, LOAD_AMOUNT } from '../adapter.ts';
import { BANKS, FLOWS, PRICE_PER_UNIT, roleOf, type BankId, type FlowId, type PartyId } from '../domain.ts';
import { DeadlineError, withDeadline } from '../deadline.ts';
import type { Sample } from '../stats.ts';
import { readState, writeState } from '../state.ts';
// Server code never imports ethers itself: everything chain-related comes from stealth-address, so one ethers copy is in play.
import {
  Contract, JsonRpcProvider, TRANCHE_A, Wallet, announcements, artifact, biRows, cert, chainNow, contracts, pay, read,
  type Deployed, type LoggedAnnouncement,
} from '../../../../stealth-address/ts/chain.ts';
import { parseBondMetadata } from '../../../../stealth-address/ts/bond.ts';
import { openMemo } from '../../../../stealth-address/ts/memo.ts';
import { scan, scanView, type Found, type ViewKeyHolder } from '../../../../stealth-address/ts/stealth.ts';
import { parseTokenMetadata } from '../../../../stealth-address/ts/token.ts';

export interface BankKeys { spendKey: string; viewKey: string; metaAddress: string; identityKey: string }
export interface PoolEntry { stealthAddress: string; privateKey: string; used: boolean }
export interface StealthState {
  chainId: bigint;
  deployerKey: string; // the deployer plays BI: issuer, custodian, certificate signer
  rpcUrl?: string; // Besu endpoint the stack was deployed on; load() reconnects to it
  deployed: Deployed;
  banks: Record<BankId, BankKeys>;
  pool: Record<string, PoolEntry[]>; // 'A>B': funded stealth addresses of A reserved for the stress test
}

const LABELS: [string, string, string, string] = ['Alamat stealth & enkripsi memo', 'Tanda tangan bank', 'Masuk block Besu', 'BI memindai dengan view key'];
const FLOW_IDS: FlowId[] = ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp'];
const PAIRS: [BankId, BankId][] = [['A', 'B'], ['B', 'C'], ['C', 'A']];
const TX_MS = 120_000;
const HEALTH_MS = 2000;
const ESCROW_TTL = 600n; // seconds; the escrow is settled right away, the window only has to outlast the run
const NO_BALANCE = 'Saldo di satu alamat stealth tidak cukup';
const lc = (s: string) => s.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx { kind: 'rd' | 'bond'; stealthAddress: string; ephemeralPubKey: string; memo: string; amount: bigint } // what the sender built
type Holding = Found & { balance: bigint };

// 'partial' only if the outsider's own reads really came back empty; anything else is a privacy break, never papered over.
export function outsiderVerdict(hits: number, opened: unknown): 'partial' {
  if (hits === 0 && opened === null) return 'partial';
  throw new Error('Pihak luar ternyata bisa membaca transaksi');
}

export function createStealthAdapter(state: StealthState, rpcUrl = state.rpcUrl ?? 'http://127.0.0.1:8545'): ModelAdapter {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const { deployed: d, chainId, banks } = state;
  const bi = new Wallet(state.deployerKey, provider);
  const reader = contracts(d, provider);
  const asBi = contracts(d, bi);
  const holders: ViewKeyHolder[] = BANKS.map((b) => ({ id: b, viewKey: banks[b].viewKey, metaAddress: banks[b].metaAddress }));
  const identity = new Map<string, PartyId>([[lc(bi.address), 'BI'], ...BANKS.map((b): [string, PartyId] => [lc(new Wallet(banks[b].identityKey).address), b])]);
  const partyOf = (addr: string | null): PartyId | null => (addr === null ? null : identity.get(lc(addr)) ?? null);

  let gasPriceP: Promise<bigint> | undefined;
  const gasPrice = () => (gasPriceP ??= provider.getFeeData().then((f) => f.gasPrice ?? 0n, (e) => { gasPriceP = undefined; throw e; }));

  // Sends from one wallet must not race on the nonce: BI (and anything it shares) submits one at a time.
  let sendTail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = sendTail.then(fn); sendTail = r.catch(() => {}); return r; };

  // Own receipt poll (ethers' tx.wait polls every 4 s, which would dominate the latency being measured).
  async function confirm(tx: { hash: string }) {
    const limit = Date.now() + TX_MS;
    for (;;) {
      const r = await provider.getTransactionReceipt(tx.hash);
      if (r) {
        if (r.status !== 1) throw new Error(`Transaksi ${tx.hash} gagal di chain`);
        return r;
      }
      if (Date.now() > limit) throw new DeadlineError('Transaksi', TX_MS);
      await sleep(500);
    }
  }

  // All announcements since the deploy, read incrementally (a scan walks the whole history).
  let cache: LoggedAnnouncement[] = [];
  let upTo = d.fromBlock - 1;
  let syncTail: Promise<unknown> = Promise.resolve();
  const sync = async () => {
    const head = await provider.getBlockNumber();
    if (head <= upTo) return;
    cache = cache.concat(await announcements(provider, d, upTo + 1, null, head));
    upTo = head;
  };
  const refresh = async () => { const r = syncTail.then(sync); syncTail = r.catch(() => {}); await r; return cache; };
  const ofToken = (anns: LoggedAnnouncement[], token: string) => anns.filter((a) => lc(a.caller) === lc(token));

  const tokenOf = (asset: 'RD' | 'DFABI') => (asset === 'RD' ? d.rd : d.bond);
  const balance = (asset: 'RD' | 'DFABI', addr: string): Promise<bigint> =>
    asset === 'RD' ? reader.rd.balanceOf(addr) : reader.bond.balanceOfByPartition(TRANCHE_A, addr);
  const unused = (a: BankId, b: BankId) => (state.pool[`${a}>${b}`] ??= []).filter((e) => !e.used);
  const reserved = () => new Set(PAIRS.flatMap(([a, b]) => unused(a, b).map((e) => lc(e.stealthAddress))));

  // Every stealth address the bank received this asset at (minus the ones reserved for the stress test), with its balance.
  async function holdings(bank: BankId, asset: 'RD' | 'DFABI'): Promise<Holding[]> {
    const k = banks[bank];
    const skip = reserved();
    const found = scan(ofToken(await refresh(), tokenOf(asset)), k.viewKey, k.spendKey).filter((f) => !skip.has(lc(f.stealthAddress)));
    const bals = await Promise.all(found.map((f) => balance(asset, f.stealthAddress)));
    return found.map((f, i) => ({ ...f, balance: bals[i] }));
  }

  // Smallest single address that covers `need`; marked busy until released so two runs never spend the same address.
  const busy = new Set<string>();
  async function claim(bank: BankId, asset: 'RD' | 'DFABI', need: bigint): Promise<Holding> {
    const ok = (await holdings(bank, asset)).filter((h) => h.balance >= need && !busy.has(lc(h.stealthAddress))).sort((x, y) => (x.balance < y.balance ? -1 : x.balance > y.balance ? 1 : 0));
    for (const h of ok) {
      busy.add(lc(h.stealthAddress));
      // Another run may have spent from it between the listing and the claim: re-read the balance now that it is ours.
      if ((await balance(asset, h.stealthAddress)) >= need) return h;
      busy.delete(lc(h.stealthAddress));
    }
    throw new Error(NO_BALANCE);
  }

  const parse = (kind: 'rd' | 'bond', md: string) => (kind === 'rd' ? parseTokenMetadata(md) : parseBondMetadata(md));
  const txAnnouncements = async (block: number, txHash: string, kind: 'rd' | 'bond') =>
    (await announcements(provider, d, block, null, block)).filter((a) => a.txHash === txHash && parse(kind, a.metadata) !== null);
  const onChain = (txHash: string, stealthAddress: string, memo: string, amount: bigint) => [
    { label: 'Tx hash', value: txHash }, { label: 'Alamat sekali pakai', value: stealthAddress },
    { label: 'Memo terenkripsi', value: memo }, { label: 'Nominal (publik)', value: amount.toString() },
  ];

  async function run(req: Parameters<ModelAdapter['run']>[0], amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const flow = FLOWS[req.flow];
    const steps: StepEvent[] = [];
    const step = async <T>(index: number, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const r = await fn();
      const e = { index, label: LABELS[index], ms: Math.round(performance.now() - t0) };
      steps.push(e);
      onStep(e);
      return r;
    };
    const gp = await gasPrice();
    const taken: string[] = [];
    const take = async (bank: BankId, asset: 'RD' | 'DFABI', need: bigint) => { const h = await claim(bank, asset, need); taken.push(lc(h.stealthAddress)); return h; };
    try {
      const rcv = banks[req.to as BankId];
      let kind: 'rd' | 'bond';
      let leg: ReturnType<typeof pay>;
      let tx: { hash: string };

      if (flow.dvp) {
        kind = 'bond';
        const seller = banks[req.from as BankId];
        const price = amount * PRICE_PER_UNIT;
        // Bond leg goes to the buyer, RD leg to the seller. Settled immediately, no expiry wait.
        const [bondLeg, rdLeg] = await step(0, async () => [
          pay(chainId, rcv.metaAddress, seller.identityKey, d.bond, amount, TRANCHE_A),
          pay(chainId, seller.metaAddress, rcv.identityKey, d.rd, price),
        ]);
        leg = bondLeg;
        tx = await step(1, async () => {
          const sellerSrc = await take(req.from as BankId, 'DFABI', amount);
          const buyerSrc = await take(req.to as BankId, 'RD', price);
          const sellerW = new Wallet(sellerSrc.privateKey, provider);
          const buyerW = new Wallet(buyerSrc.privateKey, provider);
          const expiry = (await chainNow(provider)) + ESCROW_TTL;
          const terms = {
            tradeId: '0x' + randomBytes(32).toString('hex'),
            bond: d.bond, partition: TRANCHE_A, bondAmount: amount,
            rd: d.rd, rdAmount: price,
            seller: sellerSrc.stealthAddress, buyer: buyerSrc.stealthAddress,
            expiry, refundWindow: ESCROW_TTL,
            bondLeg: { receiver: bondLeg.s.stealthAddress, ephemeralPubKey: bondLeg.s.ephemeralPubKey, viewTag: bondLeg.s.viewTag, memo: bondLeg.memo },
            rdLeg: { receiver: rdLeg.s.stealthAddress, ephemeralPubKey: rdLeg.s.ephemeralPubKey, viewTag: rdLeg.s.viewTag, memo: rdLeg.memo },
          };
          const predicted: string = await reader.factory.predict(terms);
          const settleArgs = [TRANCHE_A, terms.bondLeg.receiver, amount, terms.bondLeg.ephemeralPubKey, terms.bondLeg.viewTag, terms.bondLeg.memo];
          const settleCert = await cert(provider, d, state.deployerKey, 'transferByPartitionStealth', predicted, settleArgs, { expiry });
          const refundCert = await cert(provider, d, state.deployerKey, 'transferByPartition', predicted, [TRANCHE_A, terms.seller, amount], { expiry: expiry + ESCROW_TTL });
          await confirm(await serial(() => asBi.factory.create(terms, settleCert, refundCert)));
          const fundCert = await cert(provider, d, state.deployerKey, 'transferByPartition', sellerSrc.stealthAddress, [TRANCHE_A, predicted, amount]);
          await confirm(await contracts(d, sellerW).bond.transferByPartition(TRANCHE_A, predicted, amount, fundCert, { gasPrice: gp }));
          await confirm(await contracts(d, buyerW).rd.transfer(predicted, price, { gasPrice: gp }));
          const escrow = new Contract(predicted, artifact('DvPEscrow').abi, Wallet.createRandom().connect(provider));
          return escrow.settle({ gasPrice: gp });
        });
      } else {
        const asset = flow.asset;
        kind = asset === 'RD' ? 'rd' : 'bond';
        const token = tokenOf(asset);
        const partition = asset === 'DFABI' ? TRANCHE_A : undefined;
        const senderKey = flow.issuer ? state.deployerKey : banks[req.from as BankId].identityKey;
        leg = await step(0, async () => pay(chainId, rcv.metaAddress, senderKey, token, amount, partition));
        const { s, memo } = leg;
        tx = await step(1, async () => {
          if (flow.issuer) {
            return serial(() => asset === 'RD'
              ? asBi.rd.mintStealth(s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo, { gasPrice: gp })
              : asBi.bond.issueByPartitionStealth(TRANCHE_A, s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo, { gasPrice: gp }));
          }
          // The bank signs with the key recovered from one of its own received stealth addresses, never a normal account.
          const src = await take(req.from as BankId, asset, amount);
          const w = new Wallet(src.privateKey, provider);
          if (asset === 'RD') return contracts(d, w).rd.sendStealth(s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo, { gasPrice: gp });
          const args = [TRANCHE_A, s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo];
          const c = await cert(provider, d, state.deployerKey, 'transferByPartitionStealth', w.address, args);
          return contracts(d, w).bond.transferByPartitionStealth(...args, c, { gasPrice: gp });
        });
      }

      const rc = await step(2, () => confirm(tx));
      await step(3, async () => {
        const anns = await txAnnouncements(rc.blockNumber, rc.hash, kind);
        if (!biRows(chainId, anns, holders, kind).some((r) => r.bank === req.to)) throw new Error('BI tidak menemukan transaksi ini dengan view key');
      });
      const context: Ctx = { kind, stealthAddress: leg.s.stealthAddress, ephemeralPubKey: leg.s.ephemeralPubKey, memo: leg.memo, amount };
      return { txHash: rc.hash, block: rc.blockNumber, steps, context };
    } finally {
      for (const a of taken) busy.delete(a);
    }
  }

  async function lens(req: Parameters<ModelAdapter['lens']>[0], result: FlowResult, party: PartyId): Promise<LensView> {
    const role = roleOf(req, party);
    const ctx = result.context as Ctx;
    if (role === 'sender' || role === 'issuer') {
      return {
        party, role, verdict: 'clear', amount: ctx.amount.toString(), counterparty: { from: party, to: req.to },
        onChain: onChain(result.txHash, ctx.stealthAddress, ctx.memo, ctx.amount),
        method: 'deriveStealth + buildMemo (data yang dibangun pengirim)',
      };
    }
    const anns = await txAnnouncements(result.block, result.txHash, ctx.kind);
    if (!anns.length) throw new Error('Pengumuman transaksi tidak ditemukan di block');
    const ann = anns[0];
    const md = parse(ctx.kind, ann.metadata)!;
    const view = (verdict: LensView['verdict'], amount: bigint, counterparty: Counterparty | null, method: string): LensView =>
      ({ party, role, verdict, amount: amount.toString(), counterparty, onChain: onChain(result.txHash, ann.stealthAddress, md.memo, amount), method });

    if (role === 'receiver') {
      const k = banks[party as BankId];
      if (!scan(anns, k.viewKey, k.spendKey).length) throw new Error(`${party} tidak menemukan pembayaran ini dengan view key`);
      const r = read(chainId, ann, k.viewKey, ctx.kind);
      return view('clear', r.amount, { from: partyOf(r.sender), to: party as BankId }, 'scan + openMemo');
    }
    if (role === 'regulator') {
      const row = biRows(chainId, anns, holders, ctx.kind).find((r) => r.bank === req.to);
      if (!row) throw new Error('BI tidak menemukan transaksi ini dengan view key');
      return view('viewkey', row.amount, { from: partyOf(row.sender), to: row.bank as BankId }, 'scanAll + openMemo');
    }
    // Outsider: its own view key matches nothing and cannot open the memo; amount and token are read from the raw log.
    const k = banks[party as BankId];
    const hits = scanView(anns, { id: party, viewKey: k.viewKey, metaAddress: k.metaAddress }).length;
    const opened = openMemo(md.memo, k.viewKey, { chainId, token: md.token, stealthAddress: ann.stealthAddress, amount: md.amount, ephemeralPubKey: ann.ephemeralPubKey, partition: (md as { partition?: string }).partition });
    return view(outsiderVerdict(hits, opened), md.amount, null, `scanView (${hits} hasil) + openMemo (${opened ? 'terbuka' : 'null'})`);
  }

  // Funds `count` fresh stealth addresses of `bank` with exactly LOAD_AMOUNT RD each (BI mints) and records their keys.
  async function fund(bank: BankId, to: BankId, count: number) {
    const gp = await gasPrice();
    const k = banks[bank];
    const made = new Set<string>();
    const txs: { hash: string }[] = [];
    for (let i = 0; i < count; i++) {
      const p = pay(chainId, k.metaAddress, state.deployerKey, d.rd, LOAD_AMOUNT);
      made.add(lc(p.s.stealthAddress));
      txs.push(await serial(() => asBi.rd.mintStealth(p.s.stealthAddress, LOAD_AMOUNT, p.s.ephemeralPubKey, p.s.viewTag, p.memo, { gasPrice: gp })));
    }
    await Promise.all(txs.map(confirm));
    const found = scan(ofToken(await refresh(), d.rd), k.viewKey, k.spendKey).filter((f) => made.has(lc(f.stealthAddress)));
    if (found.length !== count) throw new Error(`Hanya ${found.length} dari ${count} alamat stealth beban ditemukan`);
    (state.pool[`${bank}>${to}`] ??= []).push(...found.map((f) => ({ stealthAddress: f.stealthAddress, privateKey: f.privateKey, used: false })));
    writeState('stealth', state);
  }

  return {
    id: 'stealth',
    stepLabels: LABELS,
    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,
    async health() {
      try {
        return await withDeadline((async () => {
          await provider.getBlockNumber();
          const codes = await Promise.all([d.announcer, d.registry, d.validator, d.bond, d.rd, d.dvpFactory].map((a) => provider.getCode(a)));
          return codes.some((c) => c === '0x')
            ? { ready: false, detail: 'Kontrak stealth belum terpasang di Besu, jalankan ulang bootstrap' }
            : { ready: true, detail: 'ok' };
        })(), HEALTH_MS, 'Besu');
      } catch (e) {
        return { ready: false, detail: e instanceof DeadlineError ? `Besu tidak menjawab dalam ${HEALTH_MS / 1000} detik` : `Besu tidak dapat dihubungi: ${(e as Error).message}` };
      }
    },
    async balanceOf(party, asset) {
      if (party === 'BI') return 0n; // BI holds no balance, it issues
      return (await holdings(party, asset)).reduce((m, h) => (h.balance > m ? h.balance : m), 0n);
    },
    run,
    lens,
    async loadCapacity() {
      return 3 * Math.min(...PAIRS.map(([a, b]) => unused(a, b).length));
    },
    async prepareLoad(n) {
      const target = Math.ceil(n / 3) + 1;
      for (const [a, b] of PAIRS) {
        const missing = target - unused(a, b).length; // top up: earlier prepared addresses count
        if (missing > 0) await fund(a, b, missing);
      }
    },
    // No lock queue here: the pooled address is the slot, and the 120 s deadline (confirm) starts at submit.
    async transferForLoad(from, to, amount, signal): Promise<Sample> {
      if (amount > LOAD_AMOUNT) throw new Error('Nominal beban melebihi isi alamat stealth');
      const entry = unused(from, to)[0];
      if (!entry) throw new Error('Alamat stealth beban habis, jalankan prepareLoad');
      if (signal?.aborted) throw new Error(CANCELLED); // slot taken, nothing submitted
      entry.used = true;
      writeState('stealth', state);
      let submittedAt = 0;
      let tx;
      try {
        const gp = await gasPrice();
        if (signal?.aborted) throw new Error(CANCELLED); // released below: nothing was submitted
        submittedAt = Date.now();
        const p = pay(chainId, banks[to].metaAddress, banks[from].identityKey, d.rd, amount);
        const w = new Wallet(entry.privateKey, provider);
        tx = await contracts(d, w).rd.sendStealth(p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo, { gasPrice: gp });
      } catch (e) {
        entry.used = false; // nothing was submitted: the pooled address is still funded
        writeState('stealth', state);
        throw e;
      }
      await confirm(tx);
      return { submittedAt, confirmedAt: Date.now() };
    },
  };
}

export async function load(): Promise<ModelAdapter | null> {
  const s = readState<StealthState>('stealth');
  return s ? createStealthAdapter(s) : null;
}
