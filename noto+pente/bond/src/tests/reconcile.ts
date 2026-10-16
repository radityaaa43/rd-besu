import * as assert from "assert";
import { reconcile } from "../lib/reconcile";

const by = (rows: Parameters<typeof reconcile>[0]) => reconcile(rows).map((f) => f.status);

// in step, no locks
assert.deepStrictEqual(by([{ account: "a", noto: 100n, tracker: 100n, locked: 0n }]), ["OK"]);
// open lock of 40: Noto shows 60 unlocked, tracker 100 total
assert.deepStrictEqual(by([{ account: "a", noto: 60n, tracker: 100n, locked: 40n }]), ["OK"]);
// hook never landed after an unlock settled: Noto already moved 40 away, tracker did not
assert.deepStrictEqual(by([{ account: "a", noto: 60n, tracker: 100n, locked: 0n }]), ["MISMATCH"]);
// tracker below Noto is always a mismatch
assert.deepStrictEqual(by([{ account: "a", noto: 100n, tracker: 60n, locked: 0n }]), ["MISMATCH"]);
// old series without the view: tracker above Noto may be open locks -> not OK, not MISMATCH
assert.deepStrictEqual(by([{ account: "a", noto: 60n, tracker: 100n }]), ["UNVERIFIABLE"]);
assert.deepStrictEqual(by([{ account: "a", noto: 100n, tracker: 100n }]), ["OK"]);
console.log("reconcile checks passed");
