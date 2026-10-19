import { randomUUID } from 'node:crypto';
import type { Capability, FlowResult, LensView, ModelAdapter, StepEvent, Verdict } from '../adapter.ts';
import { LOAD_AMOUNT } from '../adapter.ts';
import { DeadlineError, withDeadline } from '../deadline.ts';
import { BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';
// Everything Paladin goes through the bond project's modules (its SDK 1.0.0 copy is the only one in play).
import { appendTrade, loadPlatform, type Platform } from '../../../../noto+pente/bond/src/lib/platform.ts';
import { transferNoto } from '../../../../noto+pente/bond/src/lib/transfer.ts';
import { issueBond, issueCash } from '../../../../noto+pente/bond/src/lib/issue.ts';
import { executeOutright } from '../../../../noto+pente/bond/src/lib/outright.ts';
import { readNotoTx, readStateHashes, readTxReceipt, tradeSpendTxIds, waitTxIndexed, watchDispatch, type NotoTxView } from '../../../../noto+pente/bond/src/lib/receipts.ts';

const DEADLINE = 120_000;
const DVP_DEADLINE = 100_000; // inside the app's 120 s flow deadline
const NODE_PROBE_MS = 2_000;
const BALANCE_MS = 10_000;
const LENS_WAIT_MS = 20_000;
const INVESTOR: Record<BankId, string> = { A: 'investor1', B: 'investor2', C: 'investor3' };
const FLOW_IDS = Object.keys(FLOWS) as FlowId[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: in-process per-sender promise chain (same idea as zeto's `exclusive`); a multi-process server needs a shared lock.
// Noto picks input coins on the sender's node, so two concurrent transfers from one sender may select the same coin.
const chains = new Map<string, Promise<unknown>>();
// `hold(p)` lets fn keep the lock until p settles even after fn itself returned or threw (a timed-out DvP keeps running).
export async function exclusive<T>(senders: PartyId[], fn: (hold: (p: Promise<unknown>) => void) => Promise<T>): Promise<T> {
  const keys = [...new Set(senders)].sort(); // sorted: two-party locks cannot deadlock
  const previous = keys.map((k) => chains.get(k) ?? Promise.resolve());
  const held: Promise<unknown>[] = [];
  const current = Promise.allSettled(previous).then(() => fn((p) => { held.push(p); }));
  const settled: Promise<unknown> = current.catch(() => undefined).then(() => Promise.allSettled(held))
    .then(() => { keys.forEach((k) => chains.get(k) === settled && chains.delete(k)); });
  keys.forEach((k) => chains.set(k, settled));
  return current;
}

interface NotoContext { txIds: string[] } // plain flows: [tx]; dvp: [bond-leg spend tx, cash-leg spend tx]

export function createNotoAdapter(dataDir: string): ModelAdapter {
  let platform: Promise<Platform> | undefined;
  const plat = () => (platform ??= loadPlatform(dataDir).catch((e) => { platform = undefined; throw e; }));

  const bank = (p: Platform, id: BankId) => p.investors.get(INVESTOR[id])!;
  const clientOf = (p: Platform, party: PartyId) => (party === 'BI' ? p.node1 : bank(p, party).client);

  async function balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    const p = await plat();
    const token = asset === 'RD' ? p.notoCash : p.notoBond;
    if (party === 'BI') {
      const v = asset === 'RD' ? p.node1.getVerifiers(p.data.participants.cashIssuer)[0] : p.bondCustodian;
      return BigInt((await withDeadline(token.balanceOf(v, { account: v.lookup }), BALANCE_MS, `Saldo ${asset} BI`)).totalBalance);
    }
    const b = bank(p, party);
    return BigInt((await withDeadline(token.using(b.client).balanceOf(b.verifier, { account: b.verifier.lookup }), BALANCE_MS, `Saldo ${asset} ${party}`)).totalBalance);
  }

  async function untilBalance(party: PartyId, asset: 'RD' | 'DFABI', expected: bigint): Promise<void> {
    const end = Date.now() + DEADLINE;
    while ((await balanceOf(party, asset)) < expected) { // >=: the receiver may be paid by another sender meanwhile
      if (Date.now() > end) throw new DeadlineError(`Saldo ${asset} ${party} belum berubah, dan`, DEADLINE);
      await sleep(250);
    }
  }

  // address / lookup (lower-case) of every identity -> party, to name the counterparty a node actually reads in a receipt.
  let keys: Promise<Map<string, PartyId>> | undefined;
  const partyKeys = () => (keys ??= (async () => {
    const p = await plat();
    const m = new Map<string, PartyId>();
    const add = async (v: { lookup: string; address(): Promise<string> }, party: PartyId) => {
      m.set(v.lookup.toLowerCase(), party);
      m.set((await v.address()).toLowerCase(), party);
    };
    await add(p.bondCustodian, 'BI');
    await add(p.node1.getVerifiers(p.data.participants.cashIssuer)[0], 'BI');
    for (const b of BANKS) await add(bank(p, b).verifier, b);
    return m;
  })().catch((e) => { keys = undefined; throw e; }));

  async function runUnlocked(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void, hold: (p: Promise<unknown>) => void): Promise<FlowResult> {
    const p = await plat();
    const flow = FLOWS[req.flow];
    const asset = flow.asset;
    const to = req.to as BankId; // validateRequest: receiver is always a bank
    const before = await balanceOf(to, asset);
    const steps: StepEvent[] = [];
    const emit = (index: number, from: number, until: number) => {
      const s = { index, label: adapter.stepLabels[index], ms: until - from };
      steps.push(s);
      onStep(s);
    };
    const t0 = Date.now();
    // The SDK exposes one boundary for "notary checked" and "handed to the Paladin network" together, so both
    // steps are reported at it and share its duration (never split).
    let boundary: number | undefined;
    const reach = (at = Date.now()) => {
      if (boundary !== undefined) return;
      boundary = at;
      emit(0, t0, at);
      emit(1, t0, at);
    };

    if (flow.dvp) {
      const seller = bank(p, req.from as BankId), buyer = bank(p, to);
      const tradeId = randomUUID();
      let executedAt: number | undefined;
      const log = (m: string) => {
        if (m.startsWith('[atom-create]')) reach(); // every lock / prepare-unlock tx has been notarised and dispatched
        else if (m.startsWith('[settle]')) { executedAt = Date.now(); emit(2, boundary ?? t0, executedAt); } // atom executed on Besu
      };
      // The record is written from the raw promise, so it survives the deadline below (executeOutright keeps running after it).
      const raw = executeOutright(p, { seller: seller.name, buyer: buyer.name, units: amount.toString(), price: PRICE_PER_UNIT.toString(), tradeId }, log)
        .then((t) => { appendTrade(p.dataDir, t); return t; });
      hold(raw); // ponytail: the parties stay locked until executeOutright really settles, not when our deadline fires
      const trade = await withDeadline(raw, DVP_DEADLINE, 'DvP Noto').catch((e) => {
        if (e instanceof DeadlineError) throw new Error(`Status DvP belum diketahui; cek ulang (trade ${tradeId} di trades.jsonl, periksa saldo dan lock)`);
        throw e;
      });
      if (trade.status !== 'SETTLED') throw new Error(`DvP Noto gagal di langkah ${trade.failedStep ?? '?'} (${trade.status}): ${trade.error ?? ''}`);
      const executed = executedAt ?? Date.now();
      const legs = await tradeSpendTxIds(p, tradeId, seller, buyer);
      await waitTxIndexed(p.node1, legs.bond, 20_000, 'Node BI belum mengindeks transaksi DvP');
      const { txHash, block } = await readTxReceipt(p.node1, legs.bond);
      emit(3, executed, Date.now()); // executeOutright returns once all four balances moved
      return { txHash, block, steps, context: { txIds: [legs.bond, legs.cash] } satisfies NotoContext };
    }

    let submittedAt: number | undefined;
    let stop = () => {};
    const onSubmitted = (id: string) => { submittedAt = Date.now(); stop = watchDispatch(clientOf(p, req.from), id, reach); };
    const send = () => {
      const lookup = bank(p, to).verifier.lookup;
      if (req.flow === 'rd-issue') return issueCash(p, lookup, amount, onSubmitted);
      if (req.flow === 'dfabi-issue') return issueBond(p, lookup, amount, onSubmitted);
      return transferNoto(p, asset === 'RD' ? 'cash' : 'bond', bank(p, req.from as BankId), lookup, amount, onSubmitted);
    };
    let receipt: Awaited<ReturnType<typeof send>>;
    try {
      receipt = await withDeadline(send(), DEADLINE, 'Receipt Noto');
    } finally {
      stop();
    }
    const tReceipt = Date.now();
    reach(submittedAt ?? tReceipt); // watcher never saw the notary dispatch before the receipt: fall back to the submit time
    emit(2, boundary!, tReceipt);
    await untilBalance(to, asset, before + amount);
    emit(3, tReceipt, Date.now());
    return { txHash: receipt.transactionHash, block: receipt.blockNumber, steps, context: { txIds: [receipt.id] } satisfies NotoContext };
  }

  const adapter: ModelAdapter = {
    id: 'noto',
    stepLabels: ['Notary BI memeriksa', 'Kirim ke node Paladin', 'Masuk block Besu', 'State dibagikan ke pihak terkait'],

    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,

    async health() {
      try {
        const p = await withDeadline(plat(), 10_000, 'Memuat platform Noto');
        const nodes = [p.node1, ...BANKS.map((b) => bank(p, b).client)];
        const down: number[] = [];
        await Promise.all(nodes.map((c, i) => withDeadline(c.ptx.queryTransactions({ limit: 1 }), NODE_PROBE_MS, `Node ${i + 1}`).catch(() => { down.push(i + 1); })));
        if (down.length) return { ready: false, detail: `Node Paladin ${down.sort().join(', ')} tidak menjawab dalam ${NODE_PROBE_MS / 1000} detik` };
        return { ready: true, detail: 'Empat node Paladin menjawab, kontrak Noto termuat' };
      } catch (e) {
        return { ready: false, detail: `Platform Noto gagal dimuat: ${(e as Error).message}` };
      }
    },

    balanceOf,

    run: (req, amount, onStep) => exclusive(FLOWS[req.flow].dvp ? [req.from, req.to] : [req.from], (hold) => runUnlocked(req, amount, onStep, hold)),

    async lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView> {
      const p = await plat();
      const { txIds } = result.context as NotoContext;
      const role = roleOf(req, party);
      const client = clientOf(p, party);
      const mustSee = role !== 'outsider';

      // Never read a verdict off a node that has not indexed the tx yet: an absent receipt looks the same as a refusal.
      await Promise.all(txIds.map((id) => waitTxIndexed(client, id, LENS_WAIT_MS, `Node ${PARTIES[party].name} belum mengindeks transaksi`)));
      // A party's node gets the private state a moment after the receipt. readNotoTx throws on anything but the
      // node's own refusal (PD011658), so errors never turn into 'sealed'.
      let reads: NotoTxView[] = [];
      for (const end = Date.now() + LENS_WAIT_MS; ; await sleep(500)) {
        reads = await Promise.all(txIds.map((id) => readNotoTx(client, id)));
        if (!mustSee || reads.some((r) => r.visible) || Date.now() > end) break;
      }
      const visible = reads.some((r) => r.visible);
      if (mustSee && !visible) throw new Error(`Node ${party} belum memiliki state transaksi ini`);
      // Sealed needs positive evidence: the refusal above plus a state receipt that lists states the node cannot read.
      if (!visible && reads.some((r) => r.hidden.length === 0)) {
        throw new Error(`Node ${PARTIES[party].name} belum mengindeks transaksi (state receipt belum memuat state tersembunyi)`);
      }

      const hashes = await readStateHashes(client, result.txHash);
      const onChain = [
        { label: 'Tx hash', value: result.txHash },
        ...hashes.inputs.map((value) => ({ label: 'Input state', value })),
        ...hashes.outputs.map((value) => ({ label: 'Output state', value })),
      ];
      const note = req.flow === 'dfabi-issue' ? ' Penerbitan DFABI di Noto = transfer dari kustodian BI (unit belum terjual), karena BondTracker hanya mencetak ke kustodian.' : '';
      const view = (verdict: Verdict, amount: bigint | undefined, counterparty: string | null, method: string): LensView =>
        ({ party, role, verdict, amount: amount === undefined ? null : amount.toString(), counterparty, onChain, method: method + note });

      if (!visible) {
        return view('sealed', undefined, null,
          'Node bank ini hanya melihat id state (hash) tanpa isinya: domain receipt ditolak karena tidak ada data privat di node ini (<code>ptx.getStateReceipt</code>, <code>ptx.getDomainReceipt</code>).');
      }
      const amount = reads[0].amount; // dvp: the bond leg, i.e. DFABI units
      const known = await partyKeys();
      if (role === 'regulator') {
        // Owners decoded from the states BI's own node (the notary copy) holds: spenders of the inputs -> owners of the outputs.
        const [from, to] = [reads[0].spenders, reads[0].receivers].map((os) => [...new Set(os.map((o) => known.get(o)))]);
        const parties = from.length === 1 && to.length === 1 && from[0] && to[0] ? `${from[0]} → ${to[0]}` : null;
        return view('notarised', amount, parties,
          'Membaca salinan notary di node BI: pemilik input dan output transaksi (<code>ptx.getStateReceipt</code>, <code>ptx.getDomainReceipt</code>).');
      }
      const seen = reads.flatMap((r) => r.parties).map((k) => known.get(k)).filter((x): x is PartyId => !!x && x !== party && (x !== 'BI' || FLOWS[req.flow].issuer));
      return view('clear', amount, seen[0] ?? null,
        role === 'receiver'
          ? 'Node penerima menerima state privat dari notary dan membukanya (<code>ptx.getDomainReceipt</code>).'
          : 'Query state privat di node sendiri (<code>ptx.getDomainReceipt</code>).');
    },

    async loadCapacity() {
      const balances = await Promise.all(BANKS.map((b) => balanceOf(b, 'RD')));
      return 3 * Number(balances.reduce((m, x) => (x < m ? x : m)) / LOAD_AMOUNT);
    },

    async prepareLoad(n: number) {
      const p = await plat();
      const need = BigInt(Math.ceil(n / 3) + 1) * LOAD_AMOUNT;
      for (const b of BANKS) {
        const have = await balanceOf(b, 'RD');
        if (have >= need) continue;
        // One exact LOAD_AMOUNT coin per mint (the issue helper mints a single coin per call), 8 in flight; mints have no inputs, so no coin contention.
        const coins = Number((need - have + LOAD_AMOUNT - 1n) / LOAD_AMOUNT);
        const lookup = bank(p, b).verifier.lookup;
        for (let i = 0; i < coins; i += 8) {
          await withDeadline(Promise.all(Array.from({ length: Math.min(8, coins - i) }, () => issueCash(p, lookup, LOAD_AMOUNT))), DEADLINE, `Penerbitan RD ke ${b}`);
        }
        await untilBalance(b, 'RD', need);
      }
    },

    async transferForLoad(from: BankId, to: BankId, amount: bigint): Promise<Sample> {
      const p = await plat();
      return exclusive([from], async () => {
        const submittedAt = Date.now(); // after the lock: queue time is not transfer latency
        await withDeadline(transferNoto(p, 'cash', bank(p, from), bank(p, to).verifier.lookup, amount), DEADLINE, 'Transfer RD Noto');
        return { submittedAt, confirmedAt: Date.now() };
      });
    },
  };
  return adapter;
}

export async function load(): Promise<ModelAdapter | null> {
  const s = readState<{ dataDir: string }>('noto');
  return s ? createNotoAdapter(s.dataDir) : null;
}
