import * as assert from "assert";
import { notifyProgress, pendingSnapshot, type TradeRecord } from "../lib/outright";

// The progress callback of executeOutright gets pendingSnapshot(trade, bond, cash) after each lock/delegate step. A caller that
// persists it (the Lensa adapter) must see the lock ids as soon as they exist, in order, and must not change the live trade.
const trade: TradeRecord = {
  tradeId: "t1", notoBondAddress: "0xb", notoCashAddress: "0xc", seller: "A", buyer: "B",
  units: "5", price: "1.1", consideration: "5", status: "FAILED", timestamp: "2026-11-11T00:00:00.000Z",
};
const bond: { lockId?: string } = {};
const cash: { lockId?: string } = {};
const snap = () => pendingSnapshot(trade, bond as never, cash as never);

const before = snap();
assert.strictEqual(before.status, "PENDING");
assert.strictEqual(before.tradeId, "t1");
assert.strictEqual(before.bondLockId, undefined);

bond.lockId = "0xbond-lock"; // after bond-lock
const afterBond = snap();
assert.strictEqual(afterBond.bondLockId, "0xbond-lock");
assert.strictEqual(afterBond.cashLockId, undefined);

cash.lockId = "0xcash-lock"; // after cash-lock
const afterCash = snap();
assert.deepStrictEqual([afterCash.bondLockId, afterCash.cashLockId], ["0xbond-lock", "0xcash-lock"]);
assert.strictEqual(afterCash.seller, "A");
assert.strictEqual(afterCash.units, "5");

assert.strictEqual(trade.status, "FAILED"); // the live trade object is untouched
assert.strictEqual(trade.bondLockId, undefined);

// A callback that throws, or returns a rejected promise, is logged and never escapes (an unhandled rejection would kill the process).
async function callbacks() {
  const seen: string[] = [];
  const log = (m: string) => seen.push(m);
  notifyProgress(() => { throw new Error("sync boom"); }, afterCash, "cash-lock", log);
  notifyProgress(async () => { throw new Error("async boom"); }, afterCash, "cash-delegate", log);
  notifyProgress(undefined, afterCash, "bond-lock", log); // no callback: nothing happens
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, ["[cash-lock] progress callback failed: sync boom", "[cash-delegate] progress callback failed: async boom"]);
  const steps: string[] = [];
  notifyProgress((t, s) => { steps.push(`${s}:${t.bondLockId}`); }, afterCash, "bond-lock", log);
  assert.deepStrictEqual(steps, ["bond-lock:0xbond-lock"]);
  console.log("pending-snapshot checks passed");
}
callbacks().catch((e) => { console.error(e); process.exit(1); });
