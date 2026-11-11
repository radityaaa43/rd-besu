import assert from "node:assert/strict";
import { test } from "node:test";
import { LockCheckError, runLockCheck } from "../src/lock-check";

const LOCK = "0x" + "ab".repeat(32);
const OK = { success: true };

// Fake deps: `bal` is the balanceOf the party would see; each lock call records itself and moves it like the live node does.
function fake(fail: Partial<Record<"createLock" | "delegateToSelf" | "cancel", unknown>> = {}, over: { afterCreate?: bigint; afterCancel?: bigint } = {}) {
  const calls: string[] = [];
  let bal = 100n;
  const step = <T>(name: keyof typeof fail, ok: T): T => {
    calls.push(name);
    const f = fail[name];
    if (f instanceof Error) throw f;
    return f !== undefined ? (f as T) : ok;
  };
  const deps = {
    balance: async () => (calls.push("balance"), bal),
    createLock: async (amount: bigint) => {
      const r = step("createLock", { lockId: LOCK });
      bal = over.afterCreate ?? bal - amount;
      return r;
    },
    delegateToSelf: async (_id: string) => step<any>("delegateToSelf", OK),
    cancel: async (_id: string) => {
      const r = step<any>("cancel", OK);
      bal = over.afterCancel ?? 100n;
      return r;
    },
  };
  return { deps, calls, lockCalls: () => calls.filter((c) => c !== "balance") };
}

const logs: string[] = [];
const run = (f: ReturnType<typeof fake>) => ((logs.length = 0), runLockCheck(f.deps, { amount: 1n }, (l) => logs.push(l)));
const fails = async (f: ReturnType<typeof fake>, step: string) => {
  await assert.rejects(run(f), (e: any) => e instanceof LockCheckError && e.step === step);
};

// 2026-11-12 live failure (layer 7): prepareSpendLock before cancelLock on the SAME lock leaves a prepare-only tx holding the locked coin
// (coordinator state_transition_guards.go: "holds its spend locks"), so cancelLock assembled with PD011615 "Input state 0 not found" and the unit stayed locked.
// The cancel path is createLock -> delegateLock -> cancelLock; the prepared spend belongs to the Atom/DvP flow, never to a lock that is cancelled.
test("happy path runs createLock, delegateLock, cancelLock in order and NEVER prepareSpendLock", async () => {
  const f = fake();
  await run(f);
  assert.deepEqual(f.calls, ["balance", "createLock", "balance", "delegateToSelf", "balance", "cancel", "balance"]);
  assert.equal(f.calls.includes("prepareSpend"), false);
  assert.equal("prepareSpend" in f.deps, false, "the dependency is gone, so the check cannot reserve the locked coin");
});

test("createLock failure: nothing later, no cleanup cancel", async () => {
  const f = fake({ createLock: new Error("boom") });
  await fails(f, "createLock");
  assert.deepEqual(f.lockCalls(), ["createLock"]);
  assert.equal(logs.some((l) => l.includes("LOCK LEFT")), false, "no lock exists yet");
});

// Lead/orchestrator 2026-11-12: any failure after createLock prints the lockId and STOPS; no hidden cleanup cancel (it could fail the same way or hide the state).
test("delegateToSelf failure: STOP, the lockId is printed, no cleanup cancel", async () => {
  const f = fake({ delegateToSelf: new Error("boom") });
  await fails(f, "delegateLock");
  assert.deepEqual(f.lockCalls(), ["createLock", "delegateToSelf"]);
  assert.ok(logs.some((l) => l.includes("LOCK LEFT OPEN") && l.includes(LOCK) && l.includes("delegateLock")), `lockId must be printed: ${JSON.stringify(logs)}`);
});

test("cancel failure: STOP, the lockId is printed, no second cancel", async () => {
  const f = fake({ cancel: new Error("boom") });
  await fails(f, "cancelLock");
  assert.deepEqual(f.lockCalls(), ["createLock", "delegateToSelf", "cancel"]);
  assert.ok(logs.some((l) => l.includes("LOCK LEFT OPEN") && l.includes(LOCK) && l.includes("cancelLock")), `lockId must be printed: ${JSON.stringify(logs)}`);
});

test("a receipt with success:false is a failure (delegate, cancel, missing receipt)", async () => {
  await fails(fake({ delegateToSelf: { success: false, failureMessage: "reverted" } }), "delegateLock");
  await fails(fake({ delegateToSelf: { failureMessage: "no flag" } }), "delegateLock");
  const f = fake({ cancel: { success: false, failureMessage: "reverted" } });
  await fails(f, "cancelLock");
  assert.equal(f.lockCalls().filter((c) => c === "cancel").length, 1);
  const g = fake();
  g.deps.delegateToSelf = async () => undefined;
  await fails(g, "delegateLock");
});

test("balance after createLock not B0 - amount: step balance, STOP with the lockId printed, no cleanup cancel", async () => {
  const f = fake({}, { afterCreate: 100n });
  await fails(f, "balance");
  assert.deepEqual(f.lockCalls(), ["createLock"]);
  assert.ok(logs.some((l) => l.includes("LOCK LEFT OPEN") && l.includes(LOCK)));
});

test("final balance not B0: step balance, no second cancel", async () => {
  const f = fake({}, { afterCancel: 99n });
  await fails(f, "balance");
  assert.equal(f.lockCalls().filter((c) => c === "cancel").length, 1);
});

test("error messages carry no 0x + 64-hex string", async () => {
  const secret = "0x" + "cd".repeat(32);
  for (const fail of [{ createLock: new Error(`k ${secret}`) }, { delegateToSelf: { success: false, failureMessage: `k ${secret}` } }, { cancel: { success: false, failureMessage: `k ${secret} ${LOCK}` } }]) {
    const f = fake(fail);
    await assert.rejects(run(f), (e: any) => e instanceof LockCheckError && !/0x[0-9a-fA-F]{64}/.test(e.message));
  }
});
