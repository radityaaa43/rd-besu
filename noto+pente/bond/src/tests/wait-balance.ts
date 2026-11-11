import * as assert from "assert";
import { waitForBalance } from "../lib/platform";

// waitForBalance compares by direction when the caller names its side: a credit side waits for balance >= expected,
// a debit side for balance <= expected. Without a side it stays an exact match.
const at = (total: bigint) => async () => ({ totalBalance: String(total), totalStates: "1", overflow: false });
const fast = { timeoutMs: 60, pollMs: 5 };
const quiet = async <T>(f: () => Promise<T>) => { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } };

async function main() {
  // an extra credit that landed on the receiver does not fail the wait
  assert.strictEqual((await waitForBalance("receiver", at(1100n), 1000n, "credit", fast))?.totalBalance, "1100");
  // an extra debit on the payer side does not fail it either
  assert.strictEqual((await waitForBalance("payer", at(900n), 950n, "debit", fast))?.totalBalance, "900");
  // the exact amount still passes on both sides
  assert.ok(await waitForBalance("exact credit", at(1000n), 1000n, "credit", fast));
  assert.ok(await waitForBalance("exact debit", at(1000n), 1000n, "debit", fast));
  // a credit that never arrives still times out (and a debit that never happens)
  assert.strictEqual(await quiet(() => waitForBalance("missing credit", at(900n), 1000n, "credit", fast)), undefined);
  assert.strictEqual(await quiet(() => waitForBalance("missing debit", at(1000n), 950n, "debit", fast)), undefined);
  // "exact": equality only, as before
  assert.ok(await waitForBalance("exact", at(1000n), 1000n, "exact", fast));
  assert.strictEqual(await quiet(() => waitForBalance("exact miss", at(1100n), 1000n, "exact", fast)), undefined);
  // the balance arrives late: polling continues until it does
  let n = 0;
  const late = async () => ({ totalBalance: n++ < 3 ? "900" : "1000", totalStates: "1", overflow: false });
  assert.ok(await waitForBalance("late credit", late, 1000n, "credit", { timeoutMs: 500, pollMs: 5 }));
  console.log("wait-balance checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
