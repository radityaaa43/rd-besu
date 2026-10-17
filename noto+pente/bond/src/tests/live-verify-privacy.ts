import { PenteFactory, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { getCachePath, nodeConnections } from "paladin-example-common";
import { ethers } from "ethers";
import PaladinClient from "@lfdecentralizedtrust/paladin-sdk";
import atomJson from "../abis/RestrictedAtom.json";
import publicJson from "../abis/BondTrackerPublic.json";
import { loadPlatform, loadTrades } from "../lib/platform";

// LIVE read-only check of one issued series (run against a cluster, not part of `npm test`):
//   - every issuance atom: parties = [investor, custodian], executor = custodian, status Executed,
//     plus the tx hash of its AtomStatusChanged(Executed)
//   - BI (node1, a member of the issuer+custodian group) reads the amounts via pgroup_call on the
//     private BondTracker
//   - the public BondTrackerPublic answers status/schema only; the removed amount getters are gone
//   - an investor node (not a group member) cannot open the issuer+custodian group
// Last stdout line is one JSON summary.
const ATOM_STATUS_TOPIC = ethers.id("AtomStatusChanged(uint8)");
const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();

async function main(): Promise<boolean> {
  const p = await loadPlatform(getCachePath());
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`); };
  const pub = (to: string, abi: any, fn: string, data: any = {}) =>
    p.node1.ptx.call({ type: TransactionType.PUBLIC, abi, function: fn, to, from: p.bondCustodian.lookup, data }) as Promise<any>;

  // AtomStatusChanged(Executed) events, newest first; the one emitted by this atom is its execute() tx
  const executeTxOf = async (atom: string): Promise<string | undefined> => {
    const evs = (await p.node1.bidx.queryIndexedEvents({ eq: [{ field: "signature", value: ATOM_STATUS_TOPIC }], sort: ["blockNumber DESC"], limit: 100 })) as any[];
    for (const h of [...new Set(evs.map((e) => e.transactionHash as string))]) {
      for (const e of await p.node1.bidx.decodeTransactionEvents(h, atomJson.abi, "")) {
        if (e.soliditySignature.startsWith("event AtomStatusChanged") && norm(e.address) === norm(atom) && String(e.data.status) === "1") return h;
      }
    }
    return undefined;
  };
  const custodianAddr = norm(await p.bondCustodian.address());
  const atoms: Record<string, unknown>[] = [];
  for (const inv of p.data.investors) {
    const investorAddr = norm(await p.investors.get(inv.name)!.verifier.address());
    const a = inv.atomAddress;
    const parties = ((await pub(a, atomJson.abi, "getParties")).parties as string[]).map(norm);
    const executor = norm((await pub(a, atomJson.abi, "executor"))["0"]);
    const status = (await pub(a, atomJson.abi, "status"))["0"];
    const execHash = await executeTxOf(a);
    check(`${inv.name} issuance atom ${a}: parties=[investor,custodian], executor=custodian, Executed`,
      parties.length === 2 && parties[0] === investorAddr && parties[1] === custodianAddr && executor === custodianAddr && String(status) === "1",
      `status=${status} executeTx=${execHash}`);
    atoms.push({ investor: inv.name, atom: a, executeTx: execHash });
  }

  for (const t of loadTrades(p.dataDir, p.notoBond.address).filter((t) => t.status === "SETTLED" && t.atomAddress)) {
    const status = (await pub(t.atomAddress!, atomJson.abi, "status"))["0"];
    const exec = await executeTxOf(t.atomAddress!);
    check(`outright ${t.tradeId} atom ${t.atomAddress}: Executed`, String(status) === "1" && exec !== undefined, `executeTx=${exec}`);
    atoms.push({ trade: t.tradeId, atom: t.atomAddress, executeTx: exec });
  }

  // BI's private view
  const t = p.bondTracker;
  const priv = async (fn: string, data: any = {}) => (await t.call({ from: p.bondCustodian.lookup, function: fn, data }))[0];
  const holders: Record<string, string> = { custodian: await p.bondCustodian.address() };
  for (const [name, part] of p.investors) holders[name] = await part.verifier.address();
  const balances: Record<string, string> = {};
  for (const [name, addr] of Object.entries(holders)) balances[name] = String(await priv("balanceOf", { account: addr }));
  const supply = String(await priv("totalSupply"));
  const available = String(await priv("availableUnitsPrivate"));
  const price = String(await priv("discountPrice"));
  const minDenom = String(await priv("minimumDenomination"));
  check("BI reads amounts via pgroup_call on the private tracker", Number(supply) > 0 && Number(price) > 0,
    `totalSupply=${supply} availableUnitsPrivate=${available} discountPrice=${price} minimumDenomination=${minDenom} balances=${JSON.stringify(balances)}`);

  // public tracker: status only
  const pubAddr = p.data.bondTrackerPublicAddress;
  const schema = (await pub(pubAddr, publicJson.abi, "schema"))["0"];
  const status = (await pub(pubAddr, publicJson.abi, "status"))["0"];
  const trancheCount = (await pub(pubAddr, publicJson.abi, "trancheCount"))["0"];
  check("public tracker answers schema()=status-only-v1 and status()", schema === "status-only-v1", `schema=${schema} status=${status} trancheCount=${trancheCount}`);
  const names = publicJson.abi.filter((e: any) => e.type === "function").map((e: any) => e.name);
  const leaked = names.filter((n: string) => /amount|unit|price|supply|quantity|balance|denomination|total/i.test(n));
  check("public tracker ABI has no amount-like function", leaked.length === 0, `functions=${names.join(",")}`);
  for (const fn of ["totalSupply", "availableUnits", "distribution"]) {
    let reverted = false;
    try { await pub(pubAddr, [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }], fn); } catch { reverted = true; }
    check(`public tracker has no ${fn}() on chain (call fails)`, reverted, reverted ? "call failed" : "call SUCCEEDED");
  }

  // an investor node cannot open the issuer+custodian group
  const node2 = new PaladinClient(nodeConnections[1].clientOptions);
  let opened = true;
  try { const g = await new PenteFactory(node2, "pente").resumePrivacyGroup({ id: p.data.issuerCustodianGroupId }); opened = g !== undefined; } catch { opened = false; }
  check("investor node (node2) cannot open the issuer+custodian group", !opened, opened ? "group opened" : "refused");

  console.log(JSON.stringify({ series: p.data.notoBondAddress, publicTracker: pubAddr, privateTracker: p.data.bondTrackerAddress, atoms, privateReads: { supply, available, price, minDenom, balances }, publicReads: { schema, status, trancheCount }, checks }));
  return checks.every((c) => c.pass);
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
