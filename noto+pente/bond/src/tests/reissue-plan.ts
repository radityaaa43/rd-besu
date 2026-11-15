import * as assert from "assert";
import { reissuePlan } from "../lib/issue";

// Sold-out round: nothing to retire, close and reopen.
assert.deepStrictEqual(reissuePlan(0n), ["close", "activate", "mint", "begin"]);
// Units still unsold: end the round first and burn them (they are minted back with the new tranche).
assert.deepStrictEqual(reissuePlan(3n), ["forceComplete", "burnUnsold", "close", "activate", "mint", "begin"]);
console.log("reissue plan checks passed");
