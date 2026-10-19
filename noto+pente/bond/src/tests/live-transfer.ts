import { getCachePath } from "paladin-example-common";
import { parseArgs } from "util";
import { loadPlatform, waitForBalance } from "../lib/platform";
import { transferNoto } from "../lib/transfer";

// LIVE plain Noto transfer (run against a cluster, not part of `npm test`):
//   transferNoto(<token>) investor1 -> investor2 for --amount, then checks
//   - investor1 balance fell by amount and investor2 balance rose by amount (each read on its own node)
//   - investor3's node holds none of the new states (outsider sees nothing)
// Usage: ts-node src/tests/live-transfer.ts --cache <dir> [--token cash|bond] [--amount 1000]
// Last stdout line is one JSON summary.
async function main(): Promise<boolean> {
  const { values } = parseArgs({ options: { cache: { type: "string" }, token: { type: "string", default: "cash" }, amount: { type: "string", default: "1000" } } });
  const token = values.token as "cash" | "bond";
  if (token !== "cash" && token !== "bond") throw new Error(`--token must be cash or bond, got ${values.token}`);
  const amount = BigInt(values.amount!);
  const p = await loadPlatform(getCachePath());
  const noto = token === "cash" ? p.notoCash : p.notoBond;
  const [i1, i2, i3] = ["investor1", "investor2", "investor3"].map((n) => p.investors.get(n)!);
  const bal = async (who: typeof i1) =>
    BigInt((await noto.using(who.client).balanceOf(who.verifier, { account: who.verifier.lookup })).totalBalance);

  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`); };

  const before = { from: await bal(i1), to: await bal(i2) };
  const receipt = await transferNoto(p, token, i1, i2.verifier.lookup, amount);
  const fromAfter = await waitForBalance("investor1", () => noto.using(i1.client).balanceOf(i1.verifier, { account: i1.verifier.lookup }), before.from - amount);
  const toAfter = await waitForBalance("investor2", () => noto.using(i2.client).balanceOf(i2.verifier, { account: i2.verifier.lookup }), before.to + amount);
  check(`investor1 ${token} -${amount}`, fromAfter !== undefined, `${before.from} -> ${fromAfter?.totalBalance}`);
  check(`investor2 ${token} +${amount}`, toAfter !== undefined, `${before.to} -> ${toAfter?.totalBalance}`);

  // The outsider's node has none of this tx's output states.
  const outputs = (receipt.states?.confirmed ?? []).map((s) => s.id);
  const seen = await i3.client.ptx.getStateReceipt(receipt.id).catch(() => undefined);
  const seenIds = [...(seen?.confirmed ?? []), ...(seen?.spent ?? [])].map((s: { id: string }) => s.id);
  check("investor3 node holds no state of this tx", outputs.length > 0 && seenIds.length === 0, `outputs=${outputs.length} seenByInvestor3=${seenIds.length}`);

  console.log(JSON.stringify({ token, amount: String(amount), tx: receipt.transactionHash, id: receipt.id, outputs, checks }));
  return checks.every((c) => c.pass);
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
