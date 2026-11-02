/*
 * TPS stress test for private RD transfers on Zeto_Anon, V1 axis (Paladin main + PR #1189, zeto-contracts
 * v0.5.1, rapidsnark main = thread-safe prover; 4-node ACK cluster: node1 = BI, node2-4 = banks).
 *
 * Real TPS = transfers with a successful on-chain receipt per second, measured end to end.
 * Setup: deploy one fresh V1-axis Zeto_Anon per instrument (default RD and DFABI, no setERC20), then BI's issuer
 * (cashIssuer@node1 for RD, bondIssuer@node1 for DFABI) privately `mint`s UTXOS outputs per tx to PER_NODE sender
 * identities on each of SENDER_NODES (default node2,node3,node4 = the banks), on every instrument. Load: C transfers of 1 unit
 * in flight at once, each sender -> random sender on another bank, instruments alternating round-robin,
 * C ramped through STAGES. Per stage, TPS counts completions after WARMUP_SECS only. The run
 * stops on: TPS no better than the best stage twice in a row, fail ratio > MAX_FAIL, any
 * paladin pod restart, or no completion for 180 s. Drains in-flight tx, prints a table and writes
 * out/stress-<time>.json.
 *
 * Dry-run by default (prints the plan). Run under the cluster lock, port-forwards up:
 *   npm run stress -- --execute [--stages=6,12,24 --stage-secs=60 --per-sender=4 ...]
 *   npm run stress -- --execute --token=0xA,0xB (reuse tokens + their minted senders, skip setup; same order as --instruments)
 *   WARNING (V0 / Paladin v1.0.0): more than one token gave 35% (2 tokens) and 66% (4 tokens) 'Invalid proof'
 *   reverts under load and TPS collapsed (2026-10-20). Root cause, found since: the non-thread-safe rapidsnark
 *   v0.0.7 ThreadPool. Paladin main ships rapidsnark main (thread-safe), so multi-token is expected to work
 *   again; NOT yet re-measured on the new platform, treat one token as the baseline until it is.
 *   --instruments=rd,dfabi deploys one token per instrument (a sender is minted on each); each transfer takes the next
 *   token round-robin, so N instruments means N independent assembly slots per node (Paladin assembles one tx at a time per contract).
 *   --instruments=rd gives the one-token baseline.
 * Pod CPU/restarts come from kubectl with ./alibaba.yaml (or --kubeconfig=); without it the
 * restart guard is off. Load is generated from this workstation through the port-forwards, so
 * watch this machine's CPU too: a saturated client would understate the cluster.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import PaladinClient, { ITransactionReceipt, PaladinVerifier, ZetoFactory, ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { LONG_POLL_TIMEOUT, nodeConnections } from "./src/common";
import { ZETO_V1 } from "./src/zeto-v1";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const EXECUTE = process.argv.includes("--execute");
const PER_NODE = +arg("identities-per-node", "10"); // senders on each of SENDER_NODES
const SENDER_NODES = arg("sender-nodes", "2,3,4").split(",").map((n) => +n - 1); // which nodes prove+send; default = the banks (node2-4). Add 1 to use the BI node too
const UTXOS = +arg("utxos", "10"); // minted per sender; Paladin MAX_OUTPUT_COUNT is 10
const UTXO_AMOUNT = +arg("utxo-amount", "1000000");
const STAGES = arg("stages", "6,12,24,48,96").split(",").map(Number);
const STAGE_SECS = +arg("stage-secs", "60");
const WARMUP_SECS = +arg("warmup-secs", "15");
const PER_SENDER = +arg("per-sender", "4"); // max in-flight tx per sender
const TX_TIMEOUT_MS = +arg("timeout-secs", "120") * 1000;
const MAX_FAIL = +arg("max-fail", "0.2");
const BATCH = +arg("batch", "1"); // recipients per transfer tx (1 proof): outputs = BATCH + change <= 10, so BATCH <= 9
if (!Number.isInteger(BATCH) || BATCH < 1 || BATCH > 9) throw new Error("--batch must be an integer 1..9");
const MINT_PARALLEL = +arg("mint-parallel", "3");
const REUSE_TOKENS = arg("token", "").split(",").filter(Boolean); // reuse these tokens (and their minted senders), skip setup
const ISSUERS: Record<string, string> = { rd: "cashIssuer@node1", dfabi: "bondIssuer@node1" }; // both = BI
const INSTRUMENTS = arg("instruments", "rd,dfabi").split(","); // one token each; transfers rotate round-robin over them
if (INSTRUMENTS.some((i) => !ISSUERS[i])) throw new Error(`--instruments must be a subset of ${Object.keys(ISSUERS)}`);
if (REUSE_TOKENS.length && REUSE_TOKENS.length !== INSTRUMENTS.length) throw new Error("--token needs one address per --instruments entry");
if (new Set(SENDER_NODES).size < 2) throw new Error("--sender-nodes needs at least 2 banks: transfers always cross banks");
const KUBECONFIG = arg("kubeconfig", path.join(__dirname, "alibaba.yaml")); // not $KUBECONFIG: here it points at a dead cluster
const NO_PROGRESS_MS = 180_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] : 0);
const fmtT = (ms: number) => `${Math.floor(ms / 60000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
const errMsg = (e: any) => String(e?.response?.data?.error?.message ?? e?.message ?? e).slice(0, 110);

type Sender = { lookup: string; node: number; c: PaladinClient; v: PaladinVerifier; inflight: number };
type Rec = { start: number; end: number; ok: boolean; err?: string; ins: string };
type Stage = { stage: number; concurrency: number; tps: number; transfersPerSec: number; ok: number; fail: number; failRatio: number; p50: number; p95: number; p99: number; errors: Record<string, number> };

const nodes = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
const senders: Sender[] = SENDER_NODES.flatMap((n) =>
  Array.from({ length: PER_NODE }, (_, i) => {
    const lookup = `stress-n${n + 1}-${String(i).padStart(2, "0")}@node${n + 1}`;
    return { lookup, node: n, c: nodes[n], v: nodes[n].getVerifiers(lookup)[0], inflight: 0 };
  }),
);
const issuerC = nodes[0]; // BI's node, mints privately
const CAP = senders.length * PER_SENDER;

// ---- plan / dry-run ------------------------------------------------------------------------
console.log(`Zeto_Anon V1 ${INSTRUMENTS.join("+").toUpperCase()} stress: ${senders.length} senders (${PER_NODE} on each of node${SENDER_NODES.map((n) => n + 1).join(",")}), ${UTXOS} x ${UTXO_AMOUNT} minted each`);
console.log(`stages C=${STAGES.join(",")} x ${STAGE_SECS}s (warmup ${WARMUP_SECS}s), <=${PER_SENDER} in flight per sender => max concurrency ${CAP}`);
if (STAGES.some((c) => c > CAP)) console.log(`NOTE: stages above ${CAP} are capped at ${CAP}; raise --per-sender or --identities-per-node`);
console.log(`stop rules: TPS <= best twice in a row | fail ratio > ${MAX_FAIL} | pod restart | no completion for ${NO_PROGRESS_MS / 1000}s`);
console.log(`setup: ${REUSE_TOKENS.length ? `reuse ${REUSE_TOKENS.length} token(s) ${REUSE_TOKENS.join(",")}` : `deploy ${INSTRUMENTS.length} V1 Zeto_Anon token(s) (${INSTRUMENTS.map((i) => `${i} by ${ISSUERS[i]}`).join(", ")}) + ${senders.length * INSTRUMENTS.length} private mint txs (${MINT_PARALLEL} parallel)`}; max load time ${fmtT(STAGES.length * STAGE_SECS * 1000)}`);
if (!EXECUTE) {
  console.log("dry-run: nothing sent. Pass --execute to run.");
  process.exit(0);
}

// ---- receipts: one batched query per node every 500 ms (the SDK's own poll is 100 ms per tx) ---
class Poller {
  pending = new Map<string, (r: ITransactionReceipt) => void>();
  busy = false;
  constructor(private c: PaladinClient) {}
  wait(id: string) {
    return new Promise<ITransactionReceipt>((res) => this.pending.set(id, res));
  }
  async tick() {
    if (this.busy || !this.pending.size) return;
    this.busy = true;
    try {
      const ids = [...this.pending.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const rs = await this.c.ptx.queryTransactionReceipts({ in: [{ field: "id", values: batch }], limit: batch.length }).catch(() => []);
        for (const r of rs ?? []) {
          this.pending.get(r.id)?.(r);
          this.pending.delete(r.id);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
const pollers = nodes.map((c) => new Poller(c));
setInterval(() => pollers.forEach((p) => p.tick()), 500).unref();

// ---- pod monitor (kubectl) ------------------------------------------------------------------
type Pod = { pal: number; pg: number; mem: string; restarts: number; ready: boolean; host: string };
const pods = new Map<string, Pod>();
const baseRestarts = new Map<string, number>();
const maxCpu = new Map<string, { pal: number; pg: number }>();
const hostPct = new Map<string, number>(); // k8s node -> cpu% now (includes other tenants' pods)
const maxHostPct = new Map<string, number>();
let kubeOk = false;
const kube = (args: string[]) =>
  new Promise<string>((res) => execFile("kubectl", ["--kubeconfig", KUBECONFIG, "-n", "paladin", ...args], { timeout: 10_000, maxBuffer: 8e6 }, (e, out) => res(e ? "" : out)));
async function pollPods() {
  const j = await kube(["get", "pods", "-o", "json"]);
  kubeOk = !!j;
  if (!j) return;
  const top = new Map<string, { pal: number; pg: number; mem: string }>(); // `top --containers`: POD CONTAINER CPU MEM
  for (const l of (await kube(["top", "pod", "--containers", "--no-headers"])).split("\n")) {
    const [name, ctr, cpu, mem] = l.trim().split(/\s+/);
    if (!name || !cpu) continue;
    const t = top.get(name) ?? { pal: 0, pg: 0, mem: "n/a" };
    if (ctr === "paladin") (t.pal = parseInt(cpu)), (t.mem = mem);
    else if (ctr === "postgres") t.pg = parseInt(cpu);
    top.set(name, t);
  }
  for (const l of (await kube(["top", "node", "--no-headers"])).split("\n")) {
    const [host, , pc] = l.trim().split(/\s+/);
    if (host && pc) (hostPct.set(host, parseInt(pc)), maxHostPct.set(host, Math.max(maxHostPct.get(host) ?? 0, parseInt(pc))));
  }
  for (const it of JSON.parse(j).items as any[]) {
    const name: string = it.metadata.name;
    if (!name.startsWith("paladin-node")) continue;
    const cs: any[] = it.status.containerStatuses ?? [];
    const restarts = cs.reduce((s, c) => s + c.restartCount, 0);
    const t = top.get(name) ?? { pal: 0, pg: 0, mem: "n/a" };
    pods.set(name, { pal: t.pal, pg: t.pg, mem: t.mem, restarts, ready: cs.length > 0 && cs.every((c) => c.ready), host: it.spec.nodeName });
    if (!baseRestarts.has(name)) baseRestarts.set(name, restarts);
    const m = maxCpu.get(name) ?? { pal: 0, pg: 0 };
    maxCpu.set(name, { pal: Math.max(m.pal, t.pal), pg: Math.max(m.pg, t.pg) });
  }
}
let lastCpu = process.cpuUsage(), lastCpuT = Date.now(), clientPct = 0, maxClientPct = 0;
function sampleClient() {
  const c = process.cpuUsage(), now = Date.now();
  clientPct = Math.round(((c.user + c.system - lastCpu.user - lastCpu.system) / 1000 / Math.max(1, now - lastCpuT)) * 100);
  (lastCpu = c), (lastCpuT = now), (maxClientPct = Math.max(maxClientPct, clientPct));
}
const restartedPod = () => [...pods].find(([n, p]) => p.restarts > (baseRestarts.get(n) ?? p.restarts))?.[0];

// ---- run state ------------------------------------------------------------------------------
let Ts: ZetoInstance[] = [];
let rr = 0; // round-robin token cursor
const recs: Rec[] = []; // appended in completion order, so `end` is non-decreasing
let submitted = 0, inflight = 0, okN = 0, failN = 0;
let halting = "";
let t0 = 0, cur = { idx: 0, c: 0, start: 0 };
const done: Stage[] = [];
const best = { tps: 0, c: 0 };

function since(ts: number) {
  let i = recs.length;
  while (i > 0 && recs[i - 1].end >= ts) i--;
  return recs.slice(i);
}
function errTop(rs: Rec[], n = 3) {
  const h: Record<string, number> = {};
  for (const r of rs) if (!r.ok) h[r.err!] = (h[r.err!] ?? 0) + 1;
  return Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, n));
}
function stageStats(idx: number, c: number, from: number, to: number): Stage {
  const rs = recs.filter((r) => r.end >= from && r.end < to);
  const oks = rs.filter((r) => r.ok), lat = oks.map((r) => r.end - r.start);
  return {
    stage: idx + 1, concurrency: c, tps: +(oks.length / Math.max(1, (to - from) / 1000)).toFixed(2), transfersPerSec: +((oks.length * BATCH) / Math.max(1, (to - from) / 1000)).toFixed(2), ok: oks.length, fail: rs.length - oks.length,
    failRatio: rs.length ? +((rs.length - oks.length) / rs.length).toFixed(3) : 0, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), errors: errTop(rs),
  };
}

function render() {
  const now = Date.now(), L: string[] = [];
  const r5 = since(now - 5000).filter((r) => r.ok).length / 5;
  const r30 = since(now - 30_000).filter((r) => r.ok).map((r) => r.end - r.start);
  const stageOk = since(cur.start).filter((r) => r.ok).length / Math.max(1, (now - cur.start) / 1000);
  L.push(`Zeto_Anon V1 stress | ${Ts.map((t, i) => `${INSTRUMENTS[i]} ${t.address.slice(0, 8)}`).join(", ")} | ${senders.length} senders | elapsed ${fmtT(now - t0)}`);
  L.push(`stage ${cur.idx + 1}/${STAGES.length}  C=${cur.c}  ${Math.floor((now - cur.start) / 1000)}/${STAGE_SECS}s${halting ? `  HALTING: ${halting}` : ""}`);
  L.push(`tx/s now(5s) ${r5.toFixed(1)} | stage avg ${stageOk.toFixed(1)} | best stage ${best.tps} transfers/s @C=${best.c} | batch ${BATCH} => transfers/s now ${(r5 * BATCH).toFixed(1)}`);
  L.push(`ok ${okN}  fail ${failN}  in-flight ${inflight}  submitted ${submitted}`);
  L.push(`latency ms (30s)  p50 ${pct(r30, 0.5)}  p95 ${pct(r30, 0.95)}  p99 ${pct(r30, 0.99)}`);
  sampleClient();
  L.push(`this client: node proc ${clientPct}% of one core (peak ${maxClientPct}%), load1 ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} cpus`);
  L.push(kubeOk ? "pod             paladin(m) postgres(m) mem       restarts ready  host cpu%" : "pod monitor: kubectl unavailable (restart guard OFF)");
  if (kubeOk) for (const [n, p] of [...pods].sort()) L.push(`${n.padEnd(15)} ${String(p.pal).padStart(9)} ${String(p.pg).padStart(11)} ${p.mem.padEnd(8)} ${String(p.restarts - (baseRestarts.get(n) ?? 0)).padStart(8)} ${String(p.ready).padEnd(6)} ${hostPct.get(p.host) ?? "?"}%`);
  if (done.length) {
    L.push("done: stage  C    TPS  ok  fail  p50  p95");
    for (const s of done) L.push(`      ${String(s.stage).padStart(5)} ${String(s.concurrency).padStart(3)} ${s.tps.toFixed(1).padStart(6)} ${String(s.ok).padStart(3)} ${String(s.fail).padStart(5)} ${String(s.p50).padStart(4)} ${String(s.p95).padStart(4)}`);
  }
  for (const [m, n] of Object.entries(errTop(since(now - 60_000)))) L.push(`err x${n}: ${m}`);
  if (process.stdout.isTTY) process.stdout.write("\x1b[H\x1b[2J" + L.join("\n") + "\n");
  else if (Math.floor((now - t0) / 1000) % 5 === 0) console.log(L.slice(0, 5).join(" | "));
}

// ---- setup ----------------------------------------------------------------------------------
async function setup() {
  if (REUSE_TOKENS.length) {
    Ts = REUSE_TOKENS.map((a) => new ZetoInstance(issuerC, a));
  } else {
    for (const ins of INSTRUMENTS) {
      const z = await new ZetoFactory(issuerC, "zeto").newZeto(issuerC.getVerifiers(ISSUERS[ins])[0], { ...ZETO_V1 }).waitForDeploy(LONG_POLL_TIMEOUT);
      if (!z) throw new Error(`V1 Zeto_Anon ${ins} deploy returned no instance within 120s`);
      Ts.push(z);
      console.log(`deployed V1 Zeto_Anon ${ins} ${z.address} (owner ${ISSUERS[ins]})`);
    }
    const queue = Ts.flatMap((t, i) => senders.map((s) => ({ t, s, iv: issuerC.getVerifiers(ISSUERS[INSTRUMENTS[i]])[0] })));
    const total = queue.length;
    let n = 0;
    await Promise.all(
      Array.from({ length: MINT_PARALLEL }, async () => {
        for (let j; (j = queue.shift()); ) {
          const mints = Array.from({ length: UTXOS }, () => ({ to: j.s.v, amount: UTXO_AMOUNT, data: "0x" }));
          const r = await j.t.using(issuerC).mint(j.iv, { mints }).waitForReceipt(LONG_POLL_TIMEOUT);
          if (r?.success !== true) throw new Error(`mint to ${j.s.lookup} failed: ${r?.failureMessage ?? "no receipt within 120s"}`);
          console.log(`minted ${++n}/${total} (${j.s.lookup} on ${j.t.address.slice(0, 8)})`);
        }
      }),
    );
  }
  const want = REUSE_TOKENS.length ? 1n : BigInt(UTXOS) * BigInt(UTXO_AMOUNT);
  await Promise.all(
    senders.flatMap((s) =>
      Ts.map(async (t) => {
        for (const t0 = Date.now(); ; await sleep(1000)) {
          const b = await t.using(s.c).balanceOf(s.v, { account: s.lookup }).catch(() => undefined);
          if (b && BigInt(b.totalBalance) >= want) return;
          if (Date.now() - t0 > 90_000) throw new Error(`${s.lookup} balance on ${t.address} never reached ${want} (last ${b?.totalBalance})`);
        }
      }),
    ),
  );
  console.log(`setup done: ${senders.length} senders funded on ${Ts.length} token(s)`);
}

// ---- load -----------------------------------------------------------------------------------
function pickSender() {
  let min = Infinity, pool: Sender[] = [];
  for (const s of senders) {
    if (s.inflight >= PER_SENDER) continue;
    if (s.inflight < min) (min = s.inflight), (pool = [s]);
    else if (s.inflight === min) pool.push(s);
  }
  return pool[Math.floor(Math.random() * pool.length)];
}
async function slot() {
  while (!halting) {
    const s = pickSender();
    if (!s) { await sleep(20); continue; }
    const tos = new Set<Sender>(); // BATCH distinct recipients, always on another bank
    while (tos.size < BATCH) {
      const r = senders[Math.floor(Math.random() * senders.length)];
      if (r.node !== s.node) tos.add(r);
    }
    s.inflight++, inflight++, submitted++;
    const start = Date.now();
    let rec: Rec;
    let timer: NodeJS.Timeout | undefined;
    const ti = rr++ % Ts.length;
    try {
      const id = await Ts[ti].using(s.c).transfer(s.v, { transfers: [...tos].map((r) => ({ to: r.v, amount: 1, data: "0x" })) }).id;
      const r = await Promise.race([pollers[s.node].wait(id), new Promise<null>((res) => (timer = setTimeout(() => res(null), TX_TIMEOUT_MS)))]);
      if (!r) pollers[s.node].pending.delete(id);
      rec = { start, end: Date.now(), ok: r?.success === true, err: r ? (r.success ? undefined : (r.failureMessage ?? "failed").slice(0, 110)) : `no receipt in ${TX_TIMEOUT_MS / 1000}s`, ins: INSTRUMENTS[ti] };
    } catch (e) {
      rec = { start, end: Date.now(), ok: false, err: `submit: ${errMsg(e)}`, ins: INSTRUMENTS[ti] };
      await sleep(200); // do not hammer a node that is refusing
    } finally {
      clearTimeout(timer);
      s.inflight--, inflight--;
    }
    rec.ok ? okN++ : failN++;
    recs.push(rec);
  }
}

async function main() {
  for (const [i, n] of nodes.entries()) await n.bidx.getConfirmedBlockHeight().catch(() => { throw new Error(`node${i + 1} does not answer on its port-forward`); });
  await pollPods();
  if (!kubeOk) console.warn("WARNING: kubectl unavailable, pod restart guard is OFF");
  setInterval(() => pollPods().catch(() => {}), 5000).unref();
  process.on("SIGINT", () => { halting ||= "interrupted (Ctrl+C)"; });

  await setup();
  t0 = Date.now();
  const slots: Promise<void>[] = [];
  let noGain = 0, lastDone = Date.now(), lastCount = 0, stopReason = "all stages completed";
  stages: for (const [idx, want] of STAGES.entries()) {
    const c = Math.min(want, CAP);
    while (slots.length < c) slots.push(slot());
    cur = { idx, c, start: Date.now() };
    while (Date.now() - cur.start < STAGE_SECS * 1000 && !halting) {
      await sleep(1000);
      if (recs.length !== lastCount) (lastCount = recs.length), (lastDone = Date.now());
      const rp = restartedPod();
      if (rp) halting = `pod restart: ${rp}`;
      else if (inflight > 0 && Date.now() - lastDone > NO_PROGRESS_MS) halting = `no completion for ${NO_PROGRESS_MS / 1000}s`;
      render();
    }
    const end = Date.now();
    const st = stageStats(idx, c, Math.min(cur.start + WARMUP_SECS * 1000, end - 1000), end);
    done.push(st);
    if (halting) { stopReason = halting; break; }
    if (st.failRatio > MAX_FAIL) { stopReason = `fail ratio ${st.failRatio} > ${MAX_FAIL} at C=${c}`; break; }
    if (st.transfersPerSec > best.tps) (best.tps = st.transfersPerSec), (best.c = c), (noGain = 0);
    else if (++noGain >= 2) { stopReason = `TPS plateau (no gain over ${best.tps} transfers/s for 2 stages)`; break stages; }
  }
  halting ||= "finished";
  console.log(`\nstopping: ${stopReason}; draining ${inflight} in-flight tx (up to ${TX_TIMEOUT_MS / 1000}s)...`);
  await Promise.all(slots);

  console.log(`\nbatch=${BATCH} recipients per tx\nstage    C  tx/s  transfers/s     ok   fail  fail%   p50ms   p95ms   p99ms`);
  for (const s of done) console.log(`${String(s.stage).padStart(5)} ${String(s.concurrency).padStart(4)} ${s.tps.toFixed(2).padStart(5)} ${s.transfersPerSec.toFixed(2).padStart(11)} ${String(s.ok).padStart(6)} ${String(s.fail).padStart(6)} ${(s.failRatio * 100).toFixed(1).padStart(5)} ${String(s.p50).padStart(7)} ${String(s.p95).padStart(7)} ${String(s.p99).padStart(7)}`);
  const peak = done.reduce((a, b) => (b.transfersPerSec > a.transfersPerSec ? b : a), done[0]);
  console.log(`\nPEAK ${peak?.transfersPerSec} transfers/s (${peak?.tps} tx/s, batch ${BATCH}) at C=${peak?.concurrency} (stage ${peak?.stage}, measured after ${WARMUP_SECS}s warmup)`);
  console.log(`stop reason: ${stopReason}`);
  console.log(`totals: ok ${okN}  fail ${failN}  top errors ${JSON.stringify(errTop(recs))}`);
  const byIns = Object.fromEntries(INSTRUMENTS.map((i) => [i, { ok: recs.filter((r) => r.ins === i && r.ok).length, fail: recs.filter((r) => r.ins === i && !r.ok).length }]));
  console.log(`per instrument: ${JSON.stringify(byIns)}`);
  console.log(`this client: peak ${maxClientPct}% of one core`);
  for (const [n, p] of [...pods].sort()) console.log(`${n}: peak paladin ${maxCpu.get(n)?.pal}m, postgres ${maxCpu.get(n)?.pg}m, host ${p.host} peak ${maxHostPct.get(p.host)}% cpu, restarts during run ${p.restarts - (baseRestarts.get(n) ?? 0)}`);

  const perSec: number[] = [];
  for (const r of recs) if (r.ok) { const i = Math.floor((r.end - t0) / 1000); perSec[i] = (perSec[i] ?? 0) + 1; }
  const file = path.join(__dirname, "out", `stress-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({
    tokens: Object.fromEntries(Ts.map((t, i) => [INSTRUMENTS[i], t.address])), clientPeakCpuPct: maxClientPct, config: { BATCH, SENDER_NODES, PER_NODE, UTXOS, UTXO_AMOUNT, STAGES, STAGE_SECS, WARMUP_SECS, PER_SENDER, TX_TIMEOUT_MS, MAX_FAIL },
    stages: done, peak, stopReason, totals: { ok: okN, fail: failN, errors: errTop(recs, 10), byInstrument: byIns },
    pods: Object.fromEntries([...pods].map(([n, p]) => [n, { host: p.host, maxPaladinMilli: maxCpu.get(n)?.pal, maxPostgresMilli: maxCpu.get(n)?.pg, maxHostCpuPct: maxHostPct.get(p.host), restartsDuringRun: p.restarts - (baseRestarts.get(n) ?? 0) }])),
    okPerSecond: Array.from(perSec, (v) => v ?? 0),
  }, null, 2));
  console.log(`wrote ${file}`);
  process.exit(0);
}
main().catch((e) => { console.error("stress FAIL:", errMsg(e)); process.exit(1); });
