import { parseArgs } from "util";
import { getCachePath } from "paladin-example-common";
import { loadPlatform } from "./lib/platform";
import { AccountRow, reconcile } from "./lib/reconcile";

// Read-only: Noto balanceOf calls and BondTracker view calls only. Sends no transaction.
// usage: npm run reconcile -- --cache <dataDir>   (exit 1 if any account differs)
async function main(): Promise<boolean> {
  parseArgs({ options: { cache: { type: "string" } } });
  const p = await loadPlatform(getCachePath());
  const who = [
    { name: "bondCustodian", client: p.node1, verifier: p.bondCustodian },
    ...[...p.investors.values()],
  ];
  const rows: AccountRow[] = [];
  for (const w of who) {
    const address = await w.verifier.address();
    const noto = await p.notoBond.using(w.client).balanceOf(w.verifier, { account: w.verifier.lookup });
    const tracker = await p.bondTracker.call({ from: p.bondCustodian.lookup, function: "balanceOf", data: { account: address } });
    let locked: bigint | undefined;
    try {
      locked = BigInt((await p.bondTracker.call({ from: p.bondCustodian.lookup, function: "lockedBalanceOf", data: { account: address } }))[0]);
    } catch {
      locked = undefined; // tracker deployed before lockedBalanceOf existed
    }
    rows.push({ account: `${w.name} ${address}`, noto: BigInt(noto.totalBalance), tracker: BigInt(tracker[0]), locked });
  }
  const findings = reconcile(rows);
  for (const f of findings) {
    console.log(`${f.status.padEnd(12)} ${f.account}: noto=${f.noto} tracker=${f.tracker} locked=${f.locked ?? "n/a"} delta=${f.delta}`);
  }
  return findings.every((f) => f.status === "OK");
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((err) => { console.error(err); process.exit(2); });
