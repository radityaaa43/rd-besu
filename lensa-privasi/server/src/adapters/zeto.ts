import type { Capability, FlowResult, LensView, ModelAdapter, StepEvent } from '../adapter.ts';
import {
  BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleOf,
  type BankId, type FlowId, type FlowRequest, type PartyId,
} from '../domain.ts';
import { LOAD_AMOUNT } from '../adapter.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';
import { buildReport } from '../../../../zeto/src/bi-report.ts';
import {
  AtomFactory, BiLedger, PaladinClient, ZetoInstance, chainIO, heldStates, mintUtxos, nodeConnections, party, reportTo, swap, transfer, within,
  type Party, type Settled,
} from '../../../../zeto/src/flows.ts';

// Zeto_Anon on Paladin, BI on node1. Issuance is private `mint` (spike: zeto/spike-private-mint.ts);
// no setERC20 and no public tx to a Zeto contract, ever.
export interface ZetoState {
  rd: string; dfabi: string; atomFactory: string;
  groups: Record<BankId, string>; // Pente group {bank, BI}, carries the BI reports
  owners: Record<PartyId, string>; // BabyJubJub key per party (as resolved from BI's node)
  addresses: Record<PartyId, string>; // eth address per party
  fromBlock: number; privateMint: boolean;
  funded?: boolean; // false while bootstrap is still running: load() ignores the state
}

type Token = 'RD' | 'DFABI';
type Io = { token: Token; outputs: string[]; inputs: string[] }; // decimal strings: commitments / spent input ids
interface Ctx { io: Io[] }

export const LOOKUP: Record<PartyId, string> = { BI: 'bi@node1', A: 'bankA@node2', B: 'bankB@node3', C: 'bankC@node4' };
const PARTY_IDS = Object.keys(LOOKUP) as PartyId[];
const DEADLINE_MS = 120_000;
const MAX_ZETO_TX = 2; // a Paladin node has crashed under concurrent ZK proving
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex32 = (v: string) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const lower = (s: string) => s.toLowerCase();

// Module level, so every adapter instance in the process shares them. At most MAX_ZETO_TX Zeto
// operations in flight (a released slot is handed straight to the next waiter), and at most one per
// sender: two concurrent spends by one bank can pick the same UTXO (the N6 duplicate-input bug).
let active = 0;
const waiters: (() => void)[] = [];
const senderTails = new Map<string, Promise<void>>();
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_ZETO_TX) await new Promise<void>((r) => waiters.push(r)); else active++;
  try { return await fn(); } finally { const next = waiters.shift(); if (next) next(); else active--; }
}
export async function exclusive<T>(senders: PartyId[], fn: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const key of [...new Set(senders)].sort()) { // sorted: no lock-order deadlock between two-party DvPs
      const prev = senderTails.get(key);
      let release!: () => void;
      senderTails.set(key, new Promise<void>((r) => { release = r; }));
      releases.push(release);
      await prev;
    }
    return await slot(fn);
  } finally { releases.forEach((r) => r()); }
}

export function createZetoAdapter(state: ZetoState) {
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const P = Object.fromEntries(PARTY_IDS.map((id) => [id, party(clients, LOOKUP[id])])) as Record<PartyId, Party>;
  const address: Record<Token, string> = { RD: state.rd, DFABI: state.dfabi };
  const zeto = (t: Token, p: Party) => new ZetoInstance(p.c, address[t]).using(p.c);
  const factory = new AtomFactory(P.BI.c, state.atomFactory);
  const ledger = new BiLedger(
    P.BI.c,
    new Map([[lower(state.rd), 'RD'], [lower(state.dfabi), 'DFABI']]),
    new Map(PARTY_IDS.map((id) => [lower(state.addresses[id]), LOOKUP[id]])),
    new Map(PARTY_IDS.map((id) => [lower(state.owners[id]), LOOKUP[id]])),
    state.fromBlock,
  );

  // BI's ledger is polled one call at a time: the cursor is shared.
  let polling: Promise<unknown> = Promise.resolve();
  const left = (end: number) => Math.max(1, end - Date.now());
  const poll = (end: number) => (polling = polling.catch(() => {}).then(async () => {
    do { if (Date.now() > end) return; } while ((await within(ledger.pollReports(), left(end), 'Cek laporan BI')) >= 200);
  }));
  async function untilVerified(ids: string[]): Promise<void> {
    const end = Date.now() + DEADLINE_MS;
    while (ids.some((id) => !ledger.verified.has(id))) {
      if (Date.now() > end) throw new Error(`Laporan BI belum terverifikasi dalam ${DEADLINE_MS / 1000} detik`);
      await poll(end);
      await sleep(300);
    }
  }

  // The outputs/inputs a tx created/spent on one Zeto contract, read from BI's own indexer. Waits until
  // BI's node has indexed the block, so BI never judges a report against a chain it has not read yet.
  async function ioOf(token: Token, txHash: string): Promise<Io> {
    for (const end = Date.now() + DEADLINE_MS; Date.now() < end; await sleep(500)) {
      const { outputs, inputs } = await within(chainIO(P.BI.c, txHash, address[token]), left(end), 'Baca tx di node BI');
      if (outputs.length) return { token, outputs: outputs.map(String), inputs: inputs.map(String) };
    }
    throw new Error(`Node BI belum mengindeks tx ${txHash}`);
  }

  const balance = async (id: PartyId, t: Token): Promise<bigint> => {
    if (id === 'BI') throw new Error('BI tidak memegang saldo transfer');
    return BigInt((await zeto(t, P[id]).balanceOf(P[id].v, { account: LOOKUP[id] })).totalBalance);
  };
  async function requireBalance(id: PartyId, t: Token, need: bigint) {
    if ((await balance(id, t)) < need) throw new Error(`Saldo ${PARTIES[id].name} tidak cukup`); // guards the N6 duplicate-input bug
  }

  const report = (bank: BankId, t: Token, s: { receipt: Settled['receipt'] }, known: any[] = []) =>
    reportTo(state.groups[bank], P[bank], t, address[t], s.receipt, known);

  // `fund` privately mints `count` UTXOs of `amount` to a bank and reports them to BI.
  async function fund(bank: BankId, t: Token, count: number, amount: bigint) {
    for (const s of await exclusive(['BI'], () => mintUtxos(P.BI, zeto(t, P.BI), P[bank], count, amount))) await report(bank, t, s);
  }

  async function run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const flow = FLOWS[req.flow];
    const token = flow.asset;
    const from = P[req.from], to = P[req.to];
    const steps: StepEvent[] = [];
    const emit = (index: number, ms: number) => { const s = { index, label: adapter.stepLabels[index]!, ms }; steps.push(s); onStep(s); };

    // Balance checks and the send happen under the sender lock, so the check sees the previous tx's result.
    const senders: PartyId[] = flow.dvp ? [req.from, req.to] : [req.from];
    const { tx, tokens, after, t0 } = await exclusive(senders, async () => {
      if (flow.dvp) {
        await requireBalance(req.from, 'DFABI', amount);
        await requireBalance(req.to, 'RD', amount * PRICE_PER_UNIT);
      } else if (!flow.issuer) await requireBalance(req.from, token, amount);
      const t0 = Date.now();
      if (flow.issuer) {
        const tx = (await mintUtxos(from, zeto(token, from), to, 1, amount))[0]!;
        return { tx, t0, tokens: [token], after: async () => { await report(req.to as BankId, token, tx); } };
      }
      if (flow.dvp) {
        const r = await swap(factory, from, to, zeto('DFABI', from), zeto('RD', to), Number(amount), Number(PRICE_PER_UNIT));
        const [seller, buyer] = [req.from as BankId, req.to as BankId];
        return {
          tx: r.exec, t0, tokens: ['DFABI', 'RD'] as Token[],
          after: async () => {
            await report(seller, 'DFABI', { receipt: r.bond.lockRcpt });
            await report(buyer, 'RD', { receipt: r.cash.lockRcpt });
            await report(seller, 'RD', r.exec, r.cash.states);
            await report(seller, 'DFABI', r.exec, r.bond.states);
            await report(buyer, 'RD', r.exec, r.cash.states);
          },
        };
      }
      const tx = await transfer(from, zeto(token, from), to, Number(amount));
      return { tx, t0, tokens: [token], after: async () => { await report(req.from as BankId, token, tx); } };
    });

    // Proof and send are not separable through the SDK: both report the boundary at which the
    // base-ledger tx appeared (assembly, proof and endorsement done). Never a synthesised split.
    emit(0, tx.publicAt - t0);
    emit(1, tx.publicAt - t0);
    emit(2, tx.receiptAt - tx.publicAt);

    const txHash = tx.receipt.transactionHash;
    const io = await Promise.all(tokens.map((t) => ioOf(t, txHash)));
    await after();
    await untilVerified(io.flatMap((i) => i.outputs));
    emit(3, Date.now() - tx.receiptAt);
    return { txHash, block: tx.receipt.blockNumber, steps, context: { io } satisfies Ctx };
  }

  // Proves a node has indexed the tx before its (empty) answer is read as "holds nothing".
  async function indexedOn(id: PartyId, txHash: string, io: Io[]) {
    const end = Date.now() + DEADLINE_MS;
    for (const i of io) {
      for (;;) {
        const { outputs } = await within(chainIO(P[id].c, txHash, address[i.token]), left(end), `Baca tx di node ${PARTIES[id].name}`);
        if (i.outputs.every((o) => outputs.map(String).includes(o))) break;
        if (Date.now() > end) throw new Error(`Node ${PARTIES[id].name} belum mengindeks transaksi`);
        await sleep(500);
      }
    }
  }

  // What a party's own node holds of this tx's outputs: [token, amount, owner] triples.
  async function held(id: PartyId, txHash: string, io: Io[]) {
    const out: { token: Token; amount: bigint; owner: string }[] = [];
    for (const i of io) {
      for (const o of (await buildReport(P[id].c, LOOKUP[id], i.token, address[i.token], txHash)).outputs) {
        if (i.outputs.includes(o.commitment)) out.push({ token: i.token, amount: BigInt(o.amount), owner: lower(o.owner) });
      }
    }
    return out;
  }

  async function lens(req: FlowRequest, result: FlowResult, id: PartyId): Promise<LensView> {
    const { io } = result.context as Ctx;
    const role = roleOf(req, id);
    const asset = FLOWS[req.flow].asset;
    const toKey = lower(state.owners[req.to]);
    const sum = (xs: { token: Token; amount: bigint; owner: string }[]) =>
      xs.filter((x) => x.token === asset && x.owner === toKey).reduce((a, x) => a + x.amount, 0n);
    const onChain = [
      { label: 'Tx hash', value: result.txHash },
      ...io.flatMap((i) => [
        ...i.outputs.map((o) => ({ label: `Commitment ${i.token}`, value: hex32(o) })),
        ...i.inputs.map((n) => ({ label: `Input terpakai ${i.token}`, value: hex32(n) })),
      ]),
    ];
    const view = (verdict: LensView['verdict'], amount: bigint | null, counterparty: string | null, method: string): LensView =>
      ({ party: id, role, verdict, amount: amount === null ? null : amount.toString(), counterparty, onChain, method });

    if (id === 'BI') {
      await untilVerified(io.flatMap((i) => i.outputs));
      const seen = io.flatMap((i) => i.outputs.map((o) => ({ token: i.token, ...ledger.verified.get(o)!.output }))).map((o) => ({ token: o.token, amount: BigInt(o.amount), owner: lower(o.owner) }));
      return view(role === 'issuer' ? 'clear' : 'reported', sum(seen), `${PARTIES[req.from].name} → ${PARTIES[req.to].name}`,
        'Membaca laporan bank di privacy group, lalu mencocokkan ulang ke commitment on-chain (<code>BiLedger.pollReports</code>, <code>scanChain</code>).');
    }
    await indexedOn(id, result.txHash, io);
    const mine = await held(id, result.txHash, io);
    if (role === 'outsider') {
      return view(mine.length === 0 ? 'sealed' : 'partial', mine.length === 0 ? null : sum(mine), null,
        'Node bank ini tidak menerima state maupun laporan: 0 state, saldo 0.');
    }
    if (!mine.length) throw new Error(`Node ${PARTIES[id].name} tidak memiliki state transaksi ini`);
    return view('clear', sum(mine), PARTIES[id === req.to ? req.from : req.to].name,
      id === req.from ? 'Query state privat di node sendiri (<code>pstate.queryContractStates</code>).' : 'Node penerima menerima state terenkripsi dan membukanya.');
  }

  // Unspent, unlocked RD UTXOs of exactly LOAD_AMOUNT a bank owns on its own node.
  async function loadUtxos(bank: BankId): Promise<number> {
    const key = lower(state.owners[bank]);
    return (await heldStates(P[bank].c, state.rd)).filter((s) => lower(s.data.owner) === key && !s.data.locked && BigInt(s.data.amount) === LOAD_AMOUNT).length;
  }

  const adapter: ModelAdapter & { fund: typeof fund } = {
    id: 'zeto',
    stepLabels: ['Bangun bukti ZK', 'Kirim ke node Paladin', 'Masuk block Besu', 'Laporan BI terverifikasi'],
    capabilities: () => Object.fromEntries((Object.keys(FLOWS) as FlowId[]).map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,
    async health() {
      const heights = await Promise.all(clients.map((c) => c.bidx.getConfirmedBlockHeight()));
      return { ready: true, detail: `4 node Paladin siap, block ${heights[0]}` };
    },
    balanceOf: balance,
    run,
    lens,
    async loadCapacity() {
      return 3 * Math.min(...(await Promise.all(BANKS.map(loadUtxos))));
    },
    async prepareLoad(n) {
      const need = Math.ceil(n / 3) + 1;
      for (const bank of BANKS) {
        const short = need - (await loadUtxos(bank));
        if (short > 0) await fund(bank, 'RD', short, LOAD_AMOUNT);
      }
    },
    async transferForLoad(from: BankId, to: BankId, amount: bigint): Promise<Sample> {
      return exclusive([from], async () => {
        const submittedAt = Date.now();
        const tx = await transfer(P[from], zeto('RD', P[from]), P[to], Number(amount));
        await report(from, 'RD', tx);
        return { submittedAt, confirmedAt: Date.now() }; // confirmed = receipt + BI report accepted (spec 7a.2)
      });
    },
    fund,
  };
  return adapter;
}

export async function load(): Promise<ModelAdapter | null> {
  const state = readState<ZetoState>('zeto');
  return state && state.funded !== false ? createZetoAdapter(state) : null;
}
