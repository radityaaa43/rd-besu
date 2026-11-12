import assert from "node:assert/strict";
import { test } from "node:test";
import { R2ChainError, runR2Chain } from "../src/r2-chain";

const HASH = "0x" + "ab".repeat(32);
function fake(over: Partial<{ biDown: boolean; balances: bigint[]; settled: any; reportErr: Error | null }> = {}) {
  const calls: string[] = [];
  const bal = over.balances ?? [100n, 99n];
  let i = 0;
  const deps = {
    biDown: async () => (calls.push("biDown"), over.biDown ?? true),
    balanceA: async () => (calls.push("balanceA"), bal[Math.min(i++, bal.length - 1)]!),
    transfer: async (amount: number) => (calls.push(`transfer:${amount}`), over.settled ?? { success: true, transactionHash: HASH, blockNumber: 2371400 }),
    report: async () => {
      calls.push("report");
      if (over.reportErr) throw over.reportErr;
    },
  };
  return { deps, calls };
}
const run = (f: ReturnType<typeof fake>, cfg: { execute: boolean; amount?: number } = { execute: true }) => {
  const out: string[] = [];
  return runR2Chain(f.deps, { execute: cfg.execute, amount: cfg.amount ?? 1 }, (l) => out.push(l)).then((r) => ({ r, out }));
};

test("dry run (default): reads the A balance and node1 state only, sends nothing", async () => {
  const f = fake();
  const { out } = await run(f, { execute: false });
  assert.deepEqual(f.calls, ["biDown", "balanceA"]);
  assert.ok(out.some((l) => l.includes("DRY RUN")));
});

test("execute refuses while node1 answers: nothing sent", async () => {
  const f = fake({ biDown: false });
  await assert.rejects(run(f), (e: any) => e instanceof R2ChainError && e.step === "guard");
  assert.deepEqual(f.calls, ["biDown"]);
});

test("amount other than 1 is refused before anything is read", async () => {
  const f = fake();
  await assert.rejects(run(f, { execute: true, amount: 2 }), (e: any) => e instanceof R2ChainError && e.step === "config");
  assert.deepEqual(f.calls, []);
});

test("happy path: balance, ONE transfer of 1, balance, then the report attempt, in order", async () => {
  const f = fake();
  const { r, out } = await run(f);
  assert.deepEqual(f.calls, ["biDown", "balanceA", "transfer:1", "balanceA", "report"]);
  assert.equal(r.settled, true);
  assert.equal(r.report, "accepted");
  assert.ok(out.some((l) => l.includes(HASH) && l.includes("success=true") && l.includes("block=2371400")));
});

test("report failure is an OBSERVATION, not an error: class printed, no retry, no hex in the line", async () => {
  const f = fake({ reportErr: new Error("PD011206 plugin error: PD030015 GRPC connection failed for endpoint 0x" + "cd".repeat(32)) });
  const { r, out } = await run(f);
  assert.equal(f.calls.filter((c) => c === "report").length, 1, "no retry");
  assert.equal(r.settled, true);
  assert.match(r.report, /^failed PD011206/);
  assert.ok(out.every((l) => !/0x[0-9a-fA-F]{64}(?!.*success)/.test(l.replace(HASH, ""))), out.join("|"));
});

test("transfer failure: STOP, no report, no second transfer", async () => {
  const f = fake({ settled: { success: false, failureMessage: "boom 0x" + "cd".repeat(32) } });
  await assert.rejects(run(f), (e: any) => e instanceof R2ChainError && e.step === "transfer" && !/0x[0-9a-f]{64}/.test(e.message));
  assert.deepEqual(f.calls, ["biDown", "balanceA", "transfer:1"]);
});

test("balance not before-1 after a successful transfer: reported as a mismatch (still prints the hash)", async () => {
  const f = fake({ balances: [100n, 100n] });
  const { r, out } = await run(f);
  assert.equal(r.balanceOk, false);
  assert.ok(out.some((l) => l.includes("balance A before 100 after 100") && l.includes("MISMATCH")));
});
