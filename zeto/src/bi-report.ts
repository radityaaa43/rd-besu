// Option A reporting (docs/plans/2026-10-16-option-a-bi-reporting.md): a bank (node2-4) reports each
// Zeto output it created or received to BI (bi@node1) over a Pente privacy-group message; BI recomputes
// the coin commitment and matches it against the official Zeto contract events on chain.
// BI lives on node1, together with the issuers, so it already holds every state it minted, owns, or
// received: adoptOwnStates() verifies those from node1's own state store, no report needed. Only
// outputs that exist solely on a bank's node (bank-to-bank flows) need a report, and are flagged
// `unreported` without one.
//
// Commitment = Poseidon(amount, salt, owner.x, owner.y) (domains/zeto/pkg/types/states.go:66-80);
// the state id Paladin uses is that commitment. Chain outputs come from the Zeto V1 event ABIs
// (zeto-contracts v0.5.1, abis/ZetoV1Events.json): UTXOMint.outputs, UTXOTransfer.outputs,
// UTXOTransferWithEncryptedValues.outputs, UTXOWithdraw.output, UTXOBurn.output,
// ZetoLockCreated.outputs + lockedOutputs (inputs = unlocked inputs), ZetoLockSpent / ZetoLockCancelled
// .outputs + lockedOutputs (inputs = lockedInputs). ZetoLockDelegated / ZetoLockUpdated create nothing.
// V0 events (UTXOsLocked, LockDelegateChanged, from abis/IZetoLockable.json) stay decodable for old tokens.
import PaladinClient from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { buildBabyjub, buildPoseidon } from "circomlibjs";
import v1Abi from "../abis/ZetoV1Events.json";
import lockableAbi from "../abis/IZetoLockable.json"; // V0 only: UTXOsLocked, LockDelegateChanged

export const REPORT_TOPIC = "zeto-report-v1";
export const REPORT_PAGE = 200; // messages per pollReports call
const EVENT_PAGE = 1000; // indexed events per scanChain page
const STATE_PAGE = 1000; // states per adoptOwnStates page
export const ZETO_EVENTS = [...v1Abi.abi, ...lockableAbi.abi].filter((e: any) => e.type === "event");
const iface = new ethers.Interface(ZETO_EVENTS as any);
export const ZETO_EVENT_TOPICS = ZETO_EVENTS.map((e: any) => iface.getEvent(e.name)!.topicHash);
// The events that move tokens between owners: a mint, a transfer, a spent lock (the DvP leg). Lock creation / delegation / cancellation do not.
export const ZETO_MOVEMENT_TOPICS = ["UTXOMint", "UTXOTransfer", "UTXOTransferWithEncryptedValues", "ZetoLockSpent"].flatMap((n) => iface.getEvent(n)?.topicHash ?? []);

export const BI_OWN_STATE = "bi-own-state";
export type ReportOutput = { commitment: string; amount: string; salt: string; owner: string };
export type Report = { v: 1; token: string; contract: string; txHash: string; reporter: string; outputs: ReportOutput[] };
export type Status = { commitment: string; status: "verified" | "mismatch"; reason?: string };

const hex32 = (n: bigint | string) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const lower = (a: string) => a.toLowerCase();

let crypto: Promise<{ poseidon: any; babyJub: any }> | undefined;
const libs = () => (crypto ??= Promise.all([buildPoseidon(), buildBabyjub()]).then(([poseidon, babyJub]) => ({ poseidon, babyJub })));

export async function commitmentOf(o: Pick<ReportOutput, "amount" | "salt" | "owner">): Promise<bigint> {
  const { poseidon, babyJub } = await libs();
  const point = babyJub.unpackPoint(Buffer.from(o.owner.replace(/^0x/, ""), "hex"));
  if (!point) throw new Error(`owner ${o.owner} is not a BabyJubJub point`);
  const [x, y] = [babyJub.F.toObject(point[0]), babyJub.F.toObject(point[1])];
  return poseidon.F.toObject(poseidon([BigInt(o.amount), BigInt(o.salt), x, y]));
}

// Non-zero outputs a tx created, and inputs it spent, on one Zeto contract, from the tx's events.
export async function chainIO(c: PaladinClient, txHash: string, contract: string) {
  const events = await c.bidx.decodeTransactionEvents(txHash, ZETO_EVENTS as any, "mode=object");
  const outputs: bigint[] = [];
  const inputs: bigint[] = [];
  for (const e of events ?? []) {
    if (lower(e.address) !== lower(contract)) continue;
    const d = e.data ?? {};
    for (const v of [...(d.outputs ?? []), ...(d.lockedOutputs ?? []), ...(d.output !== undefined ? [d.output] : [])]) if (BigInt(v) !== 0n) outputs.push(BigInt(v));
    for (const v of [...(d.inputs ?? []), ...(d.lockedInputs ?? [])]) if (BigInt(v) !== 0n) inputs.push(BigInt(v));
  }
  return { outputs, inputs };
}
export const chainOutputs = async (c: PaladinClient, txHash: string, contract: string) => (await chainIO(c, txHash, contract)).outputs;

// Bank side: report every output of the tx that the bank's own node holds the plaintext for,
// plus any states it already has in hand (e.g. from a prepared spendLock).
export async function buildReport(c: PaladinClient, reporter: string, token: string, contract: string, txHash: string, known: any[] = []): Promise<Report> {
  const ids = (await chainOutputs(c, txHash, contract)).map(hex32);
  const schema = (await c.pstate.listSchemas("zeto")).find((s: any) => /ZetoCoin/.test(s.signature ?? ""));
  if (!schema) throw new Error("ZetoCoin schema not found");
  const held = ids.length ? await c.pstate.queryContractStates("zeto", contract, schema.id, { limit: 100, in: [{ field: ".id", values: ids }] } as any, "all") : [];
  const byId = new Map<string, any>([...known, ...held].map((s: any) => [lower(s.id), s]));
  const outputs = ids.flatMap((id) => {
    const s = byId.get(lower(id));
    return s ? [{ commitment: BigInt(id).toString(), amount: BigInt(s.data.amount).toString(), salt: s.data.salt, owner: s.data.owner }] : [];
  });
  return { v: 1, token, contract, txHash, reporter, outputs };
}

// `from` is the base-ledger signer. Paladin signs Zeto txs with a one-time key
// (core/go/internal/sequencer/coordinator/coordinating.go:456 on main), so it never names the
// bank (V1 createLock/spendLock are the exception: the lock owner's own key signs, see README); the sender is the owner of the inputs the tx spent (only the owner can spend a Zeto UTXO).
type ChainOutput = { token: string; txHash: string; from: string; inputs: string[]; firstSeen: number };

// BI side. Reads only BI's own node: messages delivered to it, its block indexer and its state store.
export class BiLedger {
  readonly verified = new Map<string, { report: Report; output: ReportOutput; reporters: Set<string> }>();
  readonly mismatches: { report: Report; status: Status }[] = [];
  readonly chain = new Map<string, ChainOutput>();
  duplicates = 0;
  private cursor = 0;
  private scanned = new Set<string>();
  private chainFrom: number; // highest block the event scan has reached: the next scan starts there

  constructor(
    private c: PaladinClient,
    private contracts: Map<string, string>, // lowercased address -> token
    private addressBook: Map<string, string>, // lowercased eth address -> identity
    private ownerBook: Map<string, string>, // lowercased BabyJubJub key -> identity
    private fromBlock: number
  ) { this.chainFrom = fromBlock; }

  identityOf = (addr: string) => this.addressBook.get(lower(addr)) ?? addr;
  ownerOf = (key: string) => this.ownerBook.get(lower(key)) ?? key;

  // Pure: does each reported output match its commitment and the chain?
  async check(r: Report): Promise<Status[]> {
    const onChain = new Set((await chainOutputs(this.c, r.txHash, r.contract)).map(String));
    const res: Status[] = [];
    for (const o of r.outputs) {
      let recomputed: bigint | undefined;
      try {
        recomputed = await commitmentOf(o);
      } catch (e) {
        res.push({ commitment: o.commitment, status: "mismatch", reason: String((e as Error).message) });
        continue;
      }
      if (recomputed.toString() !== o.commitment) res.push({ commitment: o.commitment, status: "mismatch", reason: "recomputed commitment differs" });
      else if (!onChain.has(o.commitment)) res.push({ commitment: o.commitment, status: "mismatch", reason: `not an output of ${r.txHash} on ${r.contract}` });
      else res.push({ commitment: o.commitment, status: "verified" });
    }
    return res;
  }

  async ingest(r: Report) {
    if (!this.contracts.has(lower(r.contract))) return;
    for (const s of await this.check(r)) {
      const o = r.outputs.find((x) => x.commitment === s.commitment)!;
      if (s.status === "mismatch") this.mismatches.push({ report: r, status: s });
      else if (this.verified.has(s.commitment)) {
        this.duplicates++;
        this.verified.get(s.commitment)!.reporters.add(r.reporter);
      } else this.verified.set(s.commitment, { report: r, output: o, reporters: new Set([r.reporter]) });
    }
  }

  // New report messages delivered to BI's node, in BI's receive order.
  async pollReports() {
    const msgs = (await this.c.pgroup.queryMessages({ limit: REPORT_PAGE, sort: ["localSequence"], eq: [{ field: "topic", value: REPORT_TOPIC }], gt: [{ field: "localSequence", value: this.cursor }] } as any)) ?? [];
    for (const m of msgs) {
      this.cursor = Math.max(this.cursor, m.localSequence);
      await this.ingest(m.data as Report);
    }
    return msgs.length;
  }

  // Every Zeto output on the watched contracts since fromBlock, with the tx sender.
  // Paged by block number (the index returns at most EVENT_PAGE events): each page starts at the last block of the previous one, and a
  // tx already scanned is skipped, so a block split across two pages loses nothing. A page that is full of one single block cannot advance.
  async scanChain() {
    for (;;) {
      const events = ((await this.c.bidx.queryIndexedEvents({ limit: EVENT_PAGE, sort: ["blockNumber"], in: [{ field: "signature", values: ZETO_EVENT_TOPICS }], gte: [{ field: "blockNumber", value: this.chainFrom }] } as any)) ?? []) as any[];
      for (const txHash of new Set<string>(events.map((e: any) => e.transactionHash))) {
        if (this.scanned.has(txHash)) continue;
        const from = (await this.c.bidx.getTransactionByHash(txHash))?.from ?? "?";
        for (const [contract, token] of this.contracts) {
          const io = await chainIO(this.c, txHash, contract);
          for (const o of io.outputs) this.chain.set(o.toString(), { token, txHash, from, inputs: io.inputs.map(String), firstSeen: Date.now() });
        }
        this.scanned.add(txHash); // only once it is fully read: an error above leaves it to the next scan (a mint BI never adopts is a silent hole)
      }
      const last = events.length ? Number(events[events.length - 1].blockNumber) : this.chainFrom;
      if (events.length < EVENT_PAGE) { this.chainFrom = Math.max(this.chainFrom, last); break; } // the next scan resumes at the newest block read
      if (last <= this.chainFrom) throw new Error(`more than ${EVENT_PAGE} Zeto events in block ${last}: the scan cannot page past it`);
      this.chainFrom = last;
    }
    await this.adoptOwnStates();
  }

  // One BI refresh: reports delivered to node1, the chain, and BI's own states.
  async sync() {
    while ((await this.pollReports()) >= REPORT_PAGE);
    await this.scanChain();
  }

  // BI's node1 holds the plaintext of every state minted by, owned by, or sent to a node1 identity.
  // For each such state that is an output on chain, recompute the commitment from the stored data and
  // mark it verified (reporter "bi-own-state"). No bank report is needed for those; everything else
  // (bank-to-bank outputs) still needs one. scanChain() calls it.
  async adoptOwnStates() {
    const schema = (await this.c.pstate.listSchemas("zeto")).find((s: any) => /ZetoCoin/.test(s.signature ?? ""));
    if (!schema) return 0;
    let adopted = 0;
    for (const [contract, token] of this.contracts) {
      // Paged by state id (the store returns at most STATE_PAGE states per query); the id field is ".id" in state queries (as in buildReport).
      const held: any[] = [];
      for (let after: string | undefined; ; ) {
        const page = (await this.c.pstate.queryContractStates("zeto", contract, schema.id, { limit: STATE_PAGE, sort: [".id"], ...(after ? { gt: [{ field: ".id", value: after }] } : {}) } as any, "all")) as any[];
        held.push(...page);
        if (page.length < STATE_PAGE) break;
        const lastId = page[page.length - 1].id;
        if (after !== undefined && BigInt(lastId) <= BigInt(after)) throw new Error(`state paging did not advance past ${after}: the store ignores gt on .id`);
        after = lastId;
      }
      for (const s of held) {
        const commitment = BigInt(s.id).toString();
        const onChain = this.chain.get(commitment);
        if (!onChain || this.verified.has(commitment)) continue;
        const o: ReportOutput = { commitment, amount: BigInt(s.data.amount).toString(), salt: s.data.salt, owner: s.data.owner };
        if ((await commitmentOf(o).catch(() => -1n)).toString() !== commitment) continue;
        this.verified.set(commitment, { report: { v: 1, token, contract, txHash: onChain.txHash, reporter: BI_OWN_STATE, outputs: [o] }, output: o, reporters: new Set([BI_OWN_STATE]) });
        adopted++;
      }
    }
    return adopted;
  }

  // Sender = owner(s) of the spent inputs BI already verified; deposits/mints have no inputs, so
  // they fall back to the signer (issuer-side public calls are not anonymised).
  senderOf(o: ChainOutput) {
    const owners = new Set(o.inputs.map((i) => this.verified.get(i)?.output.owner).map((k) => (k ? this.ownerOf(k) : "unknown-input-owner")));
    return owners.size ? [...owners].join("+") : this.identityOf(o.from);
  }

  unreported(graceMs: number) {
    const now = Date.now();
    return [...this.chain].filter(([c, o]) => !this.verified.has(c) && now - o.firstSeen >= graceMs).map(([commitment, o]) => ({ commitment, ...o, sender: this.senderOf(o) }));
  }
}
