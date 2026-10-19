import { getCachePath } from "paladin-example-common";
import { parseArgs } from "util";
import { loadPlatform, waitForBalance } from "../lib/platform";
import { issueBond, issueCash } from "../lib/issue";

// LIVE issuance (run against a cluster, not part of `npm test`):
//   issueCash(investor1, amount) then issueBond(investor1, amount); checks investor1's balance of each token
//   (read on its own node) rose by amount.
// Usage: ts-node src/tests/live-issue.ts --cache <dir> [--amount 1]
// Last stdout line is one JSON summary.
async function main(): Promise<boolean> {
  const { values } = parseArgs({ options: { cache: { type: "string" }, amount: { type: "string", default: "1" } } });
  const amount = BigInt(values.amount!);
  const p = await loadPlatform(getCachePath());
  const i1 = p.investors.get("investor1")!;
  const bal = (token: "cash" | "bond") => {
    const noto = (token === "cash" ? p.notoCash : p.notoBond).using(i1.client);
    return async () => noto.balanceOf(i1.verifier, { account: i1.verifier.lookup });
  };

  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const txs: Record<string, string | undefined> = {};
  for (const token of ["cash", "bond"] as const) {
    const before = BigInt((await bal(token)()).totalBalance);
    const receipt = token === "cash" ? await issueCash(p, i1.verifier.lookup, amount) : await issueBond(p, i1.verifier.lookup, amount);
    const after = await waitForBalance(`investor1 ${token}`, bal(token), before + amount);
    const pass = after !== undefined;
    checks.push({ name: `investor1 ${token} +${amount}`, pass, detail: `${before} -> ${after?.totalBalance}` });
    console.log(`${pass ? "PASS" : "FAIL"} investor1 ${token} +${amount}: ${before} -> ${after?.totalBalance}`);
    txs[token] = receipt.transactionHash;
  }
  console.log(JSON.stringify({ amount: String(amount), txs, checks }));
  return checks.every((c) => c.pass);
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
