import assert from "node:assert/strict";
import { test } from "node:test";
import { LockCheckError, runLockCheck } from "../src/lock-check";

const LOCK = "0x" + "ab".repeat(32);
const OK = { success: true };

// Fake deps: `bal` is the balanceOf the party would see; each lock call records itself and moves it like the live node does.
function fake(fail: Partial<Record<"createLock" | "prepareSpend" | "delegateToSelf" | "cancel", unknown>> = {}, over: { afterCreate?: bigint; afterCancel?: bigint } = {}) {
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
    prepareSpend: async (_id: string) => step("prepareSpend", {}),
    delegateToSelf: async (_id: string) => step<any>("delegateToSelf", OK),
    cancel: async (_id: string) => {
      const r = step<any>("cancel", OK);
      bal = over.afterCancel ?? 100n;
      return r;
    },
  };
  return { deps, calls, lockCalls: () => calls.filter((c) => c !== "balance") };
}

const run = (f: ReturnType<typeof fake>) => runLockCheck(f.deps, { amount: 1n }, () => {});
const fails = async (f: ReturnType<typeof fake>, step: string) => {
  await assert.rejects(run(f), (e: any) => e instanceof LockCheckError && e.step === step);
};

test("happy path runs the four lock calls in order", async () => {
  const f = fake();
  await run(f);
  assert.deepEqual(f.calls, ["balance", "createLock", "balance", "prepareSpend", "delegateToSelf", "balance", "cancel", "balance"]);
});

test("createLock failure: nothing later, no cleanup cancel", async () => {
  const f = fake({ createLock: new Error("boom") });
  await fails(f, "createLock");
  assert.deepEqual(f.lockCalls(), ["createLock"]);
});

test("prepareSpend failure: delegate skipped, one cleanup cancel", async () => {
  const f = fake({ prepareSpend: new Error("boom") });
  await fails(f, "prepareSpendLock");
  assert.deepEqual(f.lockCalls(), ["createLock", "prepareSpend", "cancel"]);
});

test("delegateToSelf failure: one cleanup cancel", async () => {
  const f = fake({ delegateToSelf: new Error("boom") });
  await fails(f, "delegateLock");
  assert.deepEqual(f.lockCalls(), ["createLock", "prepareSpend", "delegateToSelf", "cancel"]);
});

test("cancel failure: no second cancel", async () => {
  const f = fake({ cancel: new Error("boom") });
  await fails(f, "cancelLock");
  assert.deepEqual(f.lockCalls(), ["createLock", "prepareSpend", "delegateToSelf", "cancel"]);
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

test("balance after createLock not B0 - amount: step balance, cleanup cancel", async () => {
  const f = fake({}, { afterCreate: 100n });
  await fails(f, "balance");
  assert.deepEqual(f.lockCalls(), ["createLock", "cancel"]);
});

test("final balance not B0: step balance, no second cancel", async () => {
  const f = fake({}, { afterCancel: 99n });
  await fails(f, "balance");
  assert.equal(f.lockCalls().filter((c) => c === "cancel").length, 1);
});

test("error messages carry no 0x + 64-hex string", async () => {
  const secret = "0x" + "cd".repeat(32);
  for (const fail of [{ createLock: new Error(`k ${secret}`) }, { prepareSpend: new Error(`k ${secret}`) }, { delegateToSelf: { success: false, failureMessage: `k ${secret}` } }, { cancel: { success: false, failureMessage: `k ${secret} ${LOCK}` } }]) {
    const f = fake(fail);
    await assert.rejects(run(f), (e: any) => e instanceof LockCheckError && !/0x[0-9a-fA-F]{64}/.test(e.message));
  }
});
