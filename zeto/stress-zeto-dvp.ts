/*
 * TPS stress of Zeto DvP (DFABI vs RD, both Zeto_AnonNullifier V1), bank to bank (secondary market), straight to the
 * Paladin nodes (set ZETO_NODE_URLS for direct port-forwards, or LENSA_GW_MTLS_DIR for the gateways).
 * One DvP = the Lensa/examples-swap flow: seller createLock+prepareSpendLock on DFABI, buyer createLock+prepareSpendLock
 * on RD (legs in parallel), seller creates the Atom, both delegate their lock to it, buyer executes. 4 ZK proofs per DvP.
 *
 * Parties (user decision 2026-11-18, "bank ke bank"): sellers stress-n{2,3,4}-00..03, buyers stress-n{2,3,4}-04..07 on the
 * next bank (A->B, B->C, C->A). Each worker owns ONE seller + ONE buyer, so no identity has two DvPs in flight.
 * Banks get DFABI only by award (rule 2026-11-15), so setup awards each seller DFABI from bi@node1 by a DvP in which
 * the seller pays RD (award price is arbitrary: --award-units DFABI for --award-rd RD).
 * Load: stages of C workers (each one DvP at a time, --units DFABI for --units*--price RD), stage-secs each.
 *
 * Awards run one at a time (BI's DFABI UTXOs are few). Dry-run by default. npx ts-node stress-zeto-dvp.ts --execute [--stages=3,6,12 --stage-secs=60 --skip-award]
 */
import * as fs from "fs";
import * as path from "path";
import PaladinClient, { ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "./src/common";
import { AtomFactory } from "./src/atom";
import { LockParty, createLock, delegateLock, prepareSpend } from "./src/zeto-v1";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const EXECUTE = process.argv.includes("--execute");
const RD = arg("rd", "0xb098fa62dc69a5259a92699798e4b3a7a68b3ba2");
const DFABI = arg("dfabi", "0x374725a4c44c58d01f4f05739b257be6c71b6b9d");
const FACTORY = arg("atom-factory", "0x0ff537f240fa6e168db5bbdb176dcdd2a769f5ac");
const STAGES = arg("stages", "3,6,12").split(",").map(Number);
const STAGE_SECS = +arg("stage-secs", "60");
const WARMUP_SECS = +arg("warmup-secs", "15");
const UNITS = BigInt(arg("units", "1"));
const PRICE = BigInt(arg("price", "1"));
const AWARD_UNITS = BigInt(arg("award-units", "15"));
const AWARD_RD = BigInt(arg("award-rd", "5"));
const SKIP_AWARD = process.argv.includes("--skip-award");
const MAX_FAIL = +arg("max-fail", "0.2");
const WORKERS = Math.max(...STAGES);
if (WORKERS > 12) throw new Error("at most 12 workers (4 seller/buyer pairs per bank)");

const nodes = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
const party = (node: number, lookup: string): LockParty => ({ lookup, c: nodes[node - 1], v: nodes[node - 1].getVerifiers(lookup)[0] });
const pad = (i: number) => String(i).padStart(2, "0");
// worker w: seller bank = node 2+(w%3), index w/3; buyer on the next bank, index 4 + w/3
const pairs = Array.from({ length: WORKERS }, (_, w) => {
  const sn = 2 + (w % 3), bn = 2 + ((w + 1) % 3), i = Math.floor(w / 3);
  return { seller: party(sn, `stress-n${sn}-${pad(i)}@node${sn}`), buyer: party(bn, `stress-n${bn}-${pad(4 + i)}@node${bn}`) };
});
const BI = party(1, "bi@node1");
const tok = (addr: string, p: LockParty) => new ZetoInstance(p.c, addr);

const BALANCE_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "string" }], outputs: [{ name: "totalStates", type: "uint256" }, { name: "totalBalance", type: "uint256" }, { name: "overflow", type: "bool" }] }];
async function balance(p: LockParty, token: string): Promise<bigint> {
  const r: any = await p.c.ptx.call({ type: "private", domain: "zeto", function: "balanceOf", to: token, from: p.lookup, data: { account: p.lookup }, abi: BALANCE_ABI } as any);
  return BigInt(r.totalBalance);
}

type Phase = { locks: number; atom: number; delegate: number; execute: number };
// One DvP. Throws on any failed step (no reclaim: a failed run is reported, not hidden).
async function dvp(seller: LockParty, buyer: LockParty, units: bigint, rd: bigint): Promise<Phase> {
  const t0 = Date.now();
  const leg = async (addr: string, owner: LockParty, to: LockParty, amount: bigint) => {
    const l = await createLock(tok(addr, owner), owner, to, amount);
    return prepareSpend(tok(addr, owner), owner, l.lockId);
  };
  const [bond, cash] = await Promise.all([leg(DFABI, seller, buyer, units), leg(RD, buyer, seller, rd)]);
  const t1 = Date.now();
  const atom = await new AtomFactory(seller.c, FACTORY).create(seller.v, [
    { contractAddress: DFABI, callData: bond.call },
    { contractAddress: RD, callData: cash.call },
  ]);
  if (!atom) throw new Error("Atom create: no Atom");
  const t2 = Date.now();
  const [d1, d2] = await Promise.all([delegateLock(tok(DFABI, seller), seller, bond.lockId, atom.address), delegateLock(tok(RD, buyer), buyer, cash.lockId, atom.address)]);
  if (d1?.success !== true || d2?.success !== true) throw new Error(`delegateLock failed: ${d1?.failureMessage ?? d2?.failureMessage ?? "no receipt"}`);
  const t3 = Date.now();
  const r = await atom.using(buyer.c).execute(buyer.v);
  if (r?.success !== true) throw new Error(`Atom execute failed: ${r?.failureMessage ?? "no receipt"}`);
  return { locks: t1 - t0, atom: t2 - t1, delegate: t3 - t2, execute: Date.now() - t3 };
}

type Rec = { start: number; end: number; ok: boolean; err?: string; ph?: Phase };
const recs: Rec[] = [];
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] : 0);
const errMsg = (e: any) => String(e?.response?.data?.error?.message ?? e?.message ?? e).slice(0, 110);

async function main() {
  console.log(`Zeto DvP stress bank<->bank | RD ${RD.slice(0, 10)} DFABI ${DFABI.slice(0, 10)} | stages C=${STAGES} x ${STAGE_SECS}s (warmup ${WARMUP_SECS}s) | ${UNITS} DFABI for ${UNITS * PRICE} RD per DvP`);
  pairs.slice(0, WORKERS).forEach((p, w) => console.log(`  worker ${w}: seller ${p.seller.lookup} -> buyer ${p.buyer.lookup}`));
  console.log(SKIP_AWARD ? "setup: skip award" : `setup: award ${AWARD_UNITS} DFABI to each seller from ${BI.lookup} for ${AWARD_RD} RD (DvP)`);
  if (!EXECUTE) return console.log("dry-run: nothing sent. Pass --execute to run.");

  if (!SKIP_AWARD) {
    // One award at a time: bi@node1 holds few DFABI UTXOs and each lock reserves one until its change is confirmed, so
    // parallel awards fail with "Insufficient funds (available=...)". Sellers that already hold AWARD_UNITS are skipped.
    const t = Date.now();
    let done = 0;
    for (const p of pairs) {
      if ((await balance(p.seller, DFABI)) >= AWARD_UNITS) continue;
      await dvp(BI, p.seller, AWARD_UNITS, AWARD_RD);
      done++;
    }
    console.log(`award: ${done} awarded, ${pairs.length - done} already funded, ${((Date.now() - t) / 1000).toFixed(0)}s`);
  }

  const stages: any[] = [];
  let active = 0, stop = "all stages completed";
  const worker = async (w: number, until: () => boolean) => {
    while (!until()) {
      const start = Date.now();
      try { const ph = await dvp(pairs[w].seller, pairs[w].buyer, UNITS, UNITS * PRICE); recs.push({ start, end: Date.now(), ok: true, ph }); }
      catch (e) { recs.push({ start, end: Date.now(), ok: false, err: errMsg(e) }); }
    }
  };
  const running: Promise<void>[] = [];
  let ended = false;
  for (const [si, c] of STAGES.entries()) {
    for (; active < c; active++) running.push(worker(active, () => ended));
    const s0 = Date.now(), from = s0 + WARMUP_SECS * 1000, end = s0 + STAGE_SECS * 1000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 5000));
      const win = recs.filter((r) => r.end >= s0);
      console.log(`stage ${si + 1}/${STAGES.length} C=${c} ${Math.round((Date.now() - s0) / 1000)}s | ok ${win.filter((r) => r.ok).length} fail ${win.filter((r) => !r.ok).length}`);
    }
    const win = recs.filter((r) => r.end >= from && r.end <= end), ok = win.filter((r) => r.ok), lat = ok.map((r) => r.end - r.start);
    const avg = (k: keyof Phase) => (ok.length ? Math.round(ok.reduce((a, r) => a + r.ph![k], 0) / ok.length) : 0);
    const st = { stage: si + 1, C: c, dvpPerSec: ok.length / ((end - from) / 1000), ok: ok.length, fail: win.length - ok.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), phases: { locks: avg("locks"), atom: avg("atom"), delegate: avg("delegate"), execute: avg("execute") } };
    stages.push(st);
    if (win.length && st.fail / win.length > MAX_FAIL) { stop = `fail ratio > ${MAX_FAIL} at C=${c}`; break; }
  }
  ended = true;
  console.log("stopping: draining in-flight DvPs...");
  await Promise.race([Promise.all(running), new Promise((r) => setTimeout(r, 180_000))]);

  console.log("\nstage   C  DvP/s  tx/s(x8)  ok  fail   p50ms   p95ms | avg ms: locks+proofs  atom  delegate  execute");
  for (const s of stages) console.log(`${String(s.stage).padStart(5)} ${String(s.C).padStart(3)} ${s.dvpPerSec.toFixed(2).padStart(6)} ${(s.dvpPerSec * 8).toFixed(2).padStart(9)} ${String(s.ok).padStart(4)} ${String(s.fail).padStart(5)} ${String(s.p50).padStart(7)} ${String(s.p95).padStart(7)} | ${String(s.phases.locks).padStart(12)} ${String(s.phases.atom).padStart(5)} ${String(s.phases.delegate).padStart(9)} ${String(s.phases.execute).padStart(8)}`);
  const errs: Record<string, number> = {};
  recs.filter((r) => !r.ok).forEach((r) => (errs[r.err!] = (errs[r.err!] ?? 0) + 1));
  console.log(`stop reason: ${stop}\ntotals: ok ${recs.filter((r) => r.ok).length} fail ${recs.filter((r) => !r.ok).length} top errors ${JSON.stringify(errs)}`);
  const out = path.join(__dirname, "out", `stress-dvp-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ config: { RD, DFABI, STAGES, STAGE_SECS, UNITS: String(UNITS), PRICE: String(PRICE) }, stages, stop, recs }, null, 1));
  console.log(`wrote ${out}`);
}

main().then(() => process.exit(0), (e) => { console.error("stress FAIL:", errMsg(e)); process.exit(1); });
