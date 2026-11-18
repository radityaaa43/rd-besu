/*
 * Noto TPS stress, straight to the Paladin nodes (no gateway/OPA when --config points at direct URLs).
 *   --mode=transfer : closed loop RD (cash) transfers between Lensa's Noto load users stress-n<N>-<ii>@node<N>
 *                     on --sender-nodes (default 2,3,4 = the banks), one tx in flight per sender, each to the same-index user on the
 *                     next sender node. C senders active per stage, spread round-robin over the sender nodes.
 *   --mode=dvp      : bank<->bank outright DvP (DFABI vs RD) between the whitelisted investors (investor1@node2,
 *                     investor2@node3, investor3@node4) through executeOutright, so locks, rollback and the per-account
 *                     queue are the same code Lensa runs. With 3 investors every two trades share an account, so trades run one at a time.
 * Usage (dry-run without --execute):
 *   npx ts-node src/stress-noto.ts --config <direct-config.json> --cache <dir with contract-data-*.json> --mode=transfer --stages=8,16,32 --execute
 * Writes out/stress-noto-<mode>-<time>.json. A FAILED DvP leaves its lock ids in <cache>/trades.jsonl.
 */
import * as fs from "fs";
import * as path from "path";
import PaladinClient, { ITransactionReceipt } from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "paladin-example-common";
import { appendTrade, loadPlatform, Participant } from "./lib/platform";
import { executeOutright } from "./lib/outright";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const flag = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const MODE = arg("mode", "transfer");
const EXECUTE = process.argv.includes("--execute");
const STAGES = arg("stages", MODE === "dvp" ? "1" : "8,16,32").split(",").map(Number);
const STAGE_SECS = +arg("stage-secs", "60");
const WARMUP_SECS = +arg("warmup-secs", "10");
const PER_NODE = +arg("per-node", "16");
const SENDER_NODES = arg("sender-nodes", "2,3,4").split(",").map((n) => +n - 1); // default: the banks (BI's node1 load users hold no RD)
const AMOUNT = BigInt(arg("amount", "1"));
const TX_TIMEOUT_MS = +arg("timeout-secs", "120") * 1000;
const MAX_FAIL = +arg("max-fail", "0.2");
const DATA_DIR = flag("cache");
if (!DATA_DIR) throw new Error("--cache <dir> is required");
if (!["transfer", "dvp"].includes(MODE)) throw new Error("--mode must be transfer or dvp");

const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] : 0);
const errMsg = (e: any) => String(e?.response?.data?.error?.message ?? e?.message ?? e).slice(0, 110);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One batched receipt query per node every 500 ms; the SDK's own wait polls every 100 ms per tx.
class Poller {
  pending = new Map<string, (r: ITransactionReceipt) => void>();
  busy = false;
  constructor(private c: PaladinClient) { setInterval(() => this.tick(), 500).unref(); }
  wait(id: string, ms: number) {
    return Promise.race([
      new Promise<ITransactionReceipt>((res) => this.pending.set(id, res)),
      sleep(ms).then(() => { this.pending.delete(id); throw new Error(`no receipt in ${ms / 1000}s`); }),
    ]);
  }
  async tick() {
    if (this.busy || !this.pending.size) return;
    this.busy = true;
    try {
      const ids = [...this.pending.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const rs = await this.c.ptx.queryTransactionReceipts({ in: [{ field: "id", values: batch }], limit: batch.length } as any).catch(() => []);
        for (const r of rs ?? []) { this.pending.get(r.id)?.(r); this.pending.delete(r.id); }
      }
    } finally { this.busy = false; }
  }
}

type Rec = { start: number; end: number; ok: boolean; err?: string; node?: number; ph?: Record<string, number> };
const recs: Rec[] = [];

async function main() {
  const p = await loadPlatform(DATA_DIR!);
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  console.log(`Noto ${MODE} stress | RD ${p.data.notoCashAddress.slice(0, 10)} DFABI ${p.data.notoBondAddress.slice(0, 10)} | nodes ${nodeConnections.map((n) => n.clientOptions.url).join(" ")} | stages C=${STAGES} x ${STAGE_SECS}s (warmup ${WARMUP_SECS}s)`);

  let job: (w: number) => Promise<Omit<Rec, "start" | "end">>;
  if (MODE === "transfer") {
    const pollers = clients.map((c) => new Poller(c));
    const user = (node: number, i: number): Participant => {
      const lookup = `stress-n${node + 1}-${String(i).padStart(2, "0")}@node${node + 1}`;
      return { name: lookup, node: `node${node + 1}`, client: clients[node], verifier: clients[node].getVerifiers(lookup)[0] };
    };
    // worker w -> sender on SENDER_NODES[w % k], index floor(w / k): C senders spread evenly over the sender nodes
    const k = SENDER_NODES.length, nodeOf = (w: number) => SENDER_NODES[w % k];
    const senders = Array.from({ length: k * PER_NODE }, (_, w) => user(nodeOf(w), Math.floor(w / k)));
    const bal = await Promise.all(senders.map((s) => p.notoCash.using(s.client).balanceOf(s.verifier, { account: s.verifier.lookup }).then((b) => BigInt(b.totalBalance))));
    const need = Math.max(...STAGES), poor = senders.slice(0, need).filter((_, i) => bal[i] < AMOUNT * 10n).map((s) => s.name);
    console.log(`senders used: ${need}, balances of the first 4: ${bal.slice(0, 4).join(", ")}`);
    if (poor.length) throw new Error(`senders without ${AMOUNT * 10n} RD: ${poor.join(", ")}`);
    job = async (w) => {
      const s = senders[w], n = nodeOf(w), to = user(nodeOf(w + 1), Math.floor(w / k)).verifier;
      const id = await p.notoCash.using(s.client).transfer(s.verifier, { to, amount: AMOUNT.toString(), data: "0x" }).id;
      const r = await pollers[n].wait(id, TX_TIMEOUT_MS);
      if (r.success !== true) throw new Error(r.failureMessage ?? "failed");
      return { ok: true, node: n + 1 };
    };
  } else {
    const pairs = [["investor1", "investor2"], ["investor2", "investor3"], ["investor3", "investor1"]];
    job = async (w) => {
      const [seller, buyer] = pairs[w % pairs.length];
      // executeOutright logs "[step] ..." when each step starts; a phase = time from its log line to the next one
      const t0 = Date.now(), marks: [string, number][] = [["checks", t0]];
      const log = (m: string) => { const s = /^\[([a-z-]+)\]/.exec(m)?.[1]; if (s) marks.push([s, Date.now()]); };
      const t = await executeOutright(p, { seller, buyer, units: "1", price: "1" }, log, (tr) => appendTrade(DATA_DIR!, tr));
      appendTrade(DATA_DIR!, t);
      if (t.status !== "SETTLED") throw new Error(`${t.status} at ${t.failedStep}: ${t.error}`);
      const end = Date.now(), ph: Record<string, number> = {};
      marks.forEach(([k, v], i) => (ph[k] = (marks[i + 1]?.[1] ?? end) - v));
      return { ok: true, ph };
    };
  }

  if (!EXECUTE) { console.log("dry-run: nothing sent. Pass --execute to run."); return; }

  let active = 0, ended = false;
  const running: Promise<void>[] = [];
  const worker = async (w: number) => {
    while (!ended && w < active) {
      const start = Date.now();
      try { recs.push({ start, end: Date.now(), ...(await job(w)) }); recs[recs.length - 1].end = Date.now(); }
      catch (e) { recs.push({ start, end: Date.now(), ok: false, err: errMsg(e) }); await sleep(1000); }
    }
  };
  const stages: any[] = [];
  let stop = "completed all stages";
  for (const [si, c] of STAGES.entries()) {
    const prev = active;
    active = c;
    for (let w = prev; w < c; w++) running.push(worker(w));
    const s0 = Date.now(), from = s0 + WARMUP_SECS * 1000, end = from + STAGE_SECS * 1000;
    while (Date.now() < end) {
      await sleep(10_000);
      const win = recs.filter((r) => r.end >= s0);
      console.log(`stage ${si + 1}/${STAGES.length} C=${c} ${Math.round((Date.now() - s0) / 1000)}s | ok ${win.filter((r) => r.ok).length} fail ${win.filter((r) => !r.ok).length}`);
    }
    const win = recs.filter((r) => r.end >= from && r.end <= end), ok = win.filter((r) => r.ok), lat = ok.map((r) => r.end - r.start);
    const perNode: Record<string, number> = {};
    ok.forEach((r) => r.node && (perNode[`node${r.node}`] = (perNode[`node${r.node}`] ?? 0) + 1));
    const phases: Record<string, number> = {};
    ok.forEach((r) => Object.entries(r.ph ?? {}).forEach(([k, v]) => (phases[k] = (phases[k] ?? 0) + v / ok.length)));
    Object.keys(phases).forEach((k) => (phases[k] = Math.round(phases[k])));
    const st = { stage: si + 1, C: c, perSec: +(ok.length / STAGE_SECS).toFixed(2), ok: ok.length, fail: win.length - ok.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), perNode, phases };
    stages.push(st);
    console.log(JSON.stringify(st));
    if (win.length && st.fail / win.length > MAX_FAIL) { stop = `fail ratio > ${MAX_FAIL} at C=${c}`; break; }
  }
  ended = true;
  console.log("stopping: draining in-flight...");
  await Promise.race([Promise.all(running), sleep(180_000)]);
  const errs: Record<string, number> = {};
  recs.filter((r) => !r.ok).forEach((r) => (errs[r.err!] = (errs[r.err!] ?? 0) + 1));
  console.log(`\nmode ${MODE}  stage   C  per-sec   ok  fail   p50ms   p95ms`);
  for (const s of stages) console.log(`${" ".repeat(MODE.length + 6)}${String(s.stage).padStart(5)} ${String(s.C).padStart(3)} ${s.perSec.toFixed(2).padStart(8)} ${String(s.ok).padStart(4)} ${String(s.fail).padStart(5)} ${String(s.p50).padStart(7)} ${String(s.p95).padStart(7)}`);
  console.log(`stop reason: ${stop}\ntotals: ok ${recs.filter((r) => r.ok).length} fail ${recs.filter((r) => !r.ok).length} top errors ${JSON.stringify(errs)}`);
  const out = path.join(__dirname, "..", "out", `stress-noto-${MODE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ config: { MODE, STAGES, STAGE_SECS, AMOUNT: String(AMOUNT), RD: p.data.notoCashAddress, DFABI: p.data.notoBondAddress }, stages, stop, recs }, null, 1));
  console.log(`wrote ${out}`);
}

main().then(() => process.exit(0), (e) => { console.error("stress FAIL:", errMsg(e)); process.exit(1); });
