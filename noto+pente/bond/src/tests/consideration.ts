import * as assert from "assert";
import { computeConsideration, parseUnits } from "../lib/platform";

assert.strictEqual(computeConsideration(50n, "1.1"), 55n);
assert.strictEqual(computeConsideration(20n, "1.05"), 21n);
assert.strictEqual(computeConsideration(100n, "1"), 100n);
assert.strictEqual(computeConsideration(4n, "0.5"), 2n);
assert.throws(() => computeConsideration(3n, "1.1"), /not a whole amount/);
assert.throws(() => computeConsideration(1n, "0"), /greater than 0/);
assert.throws(() => computeConsideration(1n, "-1"), /positive decimal/);
assert.throws(() => computeConsideration(1n, "1e3"), /positive decimal/);
assert.strictEqual(parseUnits("50"), 50n);
assert.throws(() => parseUnits("0"), /positive integer/);
assert.throws(() => parseUnits("1.5"), /positive integer/);
console.log("consideration checks passed");
