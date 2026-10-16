// Live test: forces outright failures at chosen steps and checks the rollback left no trace,
// both in Noto balances and in the hooks trackers' private lock ledgers (NotoLocks).
import { PaladinVerifier, PenteFactory, PentePrivacyGroup } from "@lfdecentralizedtrust/paladin-sdk";
import * as fs from "fs";
import * as path from "path";
import { LONG_POLL_TIMEOUT, POLL_INTERVAL, getCachePath } from "paladin-example-common";
import { Participant, Platform, appendTrade, loadPlatform } from "../lib/platform";
import { OutrightParams, TradeRecord, executeOutright } from "../lib/outright";

// The tracker creates its NotoLocks in its constructor, i.e. as its first CREATE. Pente's EVM starts
// contract nonces at 0 (verified live: nonce 1 has no code).
// ethers ships with the Paladin SDK; it is only needed for this address derivation.
const sdkDir = fs.realpathSync(path.join(__dirname, "../../node_modules/@lfdecentralizedtrust/paladin-sdk"));
const { getCreateAddress } = require(require.resolve("ethers", { paths: [sdkDir] }));

const balanceAbi = (name: string) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
});

async function trackerLedger(group: PentePrivacyGroup, tracker: string, from: PaladinVerifier, who: Participant) {
  const locks = getCreateAddress({ from: tracker, nonce: 0 });
  const account = await who.verifier.address();
  const read = async (name: string) =>
    String(Object.values(await group.call({ from: from.lookup, to: locks, methodAbi: balanceAbi(name) as any, data: { account } }))[0]);
  const erc20 = String(Object.values(await group.call({ from: from.lookup, to: tracker, methodAbi: balanceAbi("balanceOf") as any, data: { account } }))[0]);
  return { locked: await read("lockedBalance"), pending: await read("pendingBalance"), erc20 };
}

async function balances(p: Platform, who: Participant) {
  const q = (t: typeof p.notoBond) =>
    t.using(who.client).balanceOf(who.verifier, { account: who.verifier.lookup }).then((b) => b.totalBalance);
  return { bond: await q(p.notoBond), cash: await q(p.notoCash) };
}

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};

async function main() {
  const p = await loadPlatform(getCachePath());
  const pente = new PenteFactory(p.node1, "pente");
  const cashGroup = await pente.resumePrivacyGroup({ id: p.data.cashGroupId });
  const bondGroup = await pente.resumePrivacyGroup({ id: p.data.issuerCustodianGroupId });
  if (!cashGroup || !bondGroup) throw new Error("cannot resume tracker privacy groups on node1");
  const [cashIssuer] = p.node1.getVerifiers(p.data.participants.cashIssuer);
  const inv = (n: string) => p.investors.get(n)!;

  // The notary node syncs the tracker with a separate private tx after it sees the on-chain
  // LockSpent/LockCancelled event, so the ledger is eventually consistent: poll until it clears.
  const checkLedgers = async (label: string, who: Participant[]) => {
    for (const w of who) {
      for (const [name, group, tracker, signer] of [
        ["bond", bondGroup, p.data.bondTrackerAddress, p.bondCustodian],
        ["cash", cashGroup, p.data.cashTrackerAddress, cashIssuer],
      ] as const) {
        const start = Date.now();
        let ledger, noto;
        do {
          ledger = await trackerLedger(group, tracker, signer, w);
          noto = (await balances(p, w))[name];
          if (ledger.locked === "0" && ledger.pending === "0" && ledger.erc20 === noto) break;
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        } while (Date.now() - start < LONG_POLL_TIMEOUT);
        const ok = ledger.locked === "0" && ledger.pending === "0" && ledger.erc20 === noto;
        check(`${label} ${name} tracker / ${w.name}`, ok, `${JSON.stringify(ledger)} noto=${noto} after ${Math.round((Date.now() - start) / 1000)}s`);
      }
    }
  };

  const record = (t: TradeRecord) => {
    appendTrade(p.dataDir, t);
    return t;
  };

  for (const failAt of ["bond-lock", "cash-prepare-unlock"] as const) {
    const seller = inv("investor1");
    const buyer = inv("investor3");
    const before = { seller: await balances(p, seller), buyer: await balances(p, buyer) };
    console.log(`\n=== Rollback after ${failAt} ===`);
    const params: OutrightParams = { seller: seller.name, buyer: buyer.name, units: 10, price: "1.2", injectFailureAfter: failAt };
    const t = record(await executeOutright(p, params));
    check(`${failAt} status`, t.status === "ROLLED_BACK", `${t.status}${t.rollbackError ? ` (${t.rollbackError})` : ""}`);
    check(`${failAt} cancel atom`, t.rollbackAtomAddress !== undefined, String(t.rollbackAtomAddress));
    const after = { seller: await balances(p, seller), buyer: await balances(p, buyer) };
    check(`${failAt} balances restored`, JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
    await checkLedgers(failAt, [seller, buyer]);
  }

  console.log("\n=== Two concurrent trades from the same seller (must serialize) ===");
  const order: string[] = [];
  const logFor = (tag: string) => (msg: string) => {
    if (msg.startsWith("[bond-lock]") || msg.startsWith("[settle]")) order.push(`${tag}:${msg.split("]")[0].slice(1)}`);
    console.log(`${tag} ${msg}`);
  };
  const [a, b] = await Promise.all([
    executeOutright(p, { seller: "investor1", buyer: "investor2", units: 5, price: "2" }, logFor("A")),
    executeOutright(p, { seller: "investor1", buyer: "investor3", units: 5, price: "2" }, logFor("B")),
  ]);
  record(a);
  record(b);
  check("concurrent A", a.status === "SETTLED", a.status);
  check("concurrent B", b.status === "SETTLED", b.status);
  check("serialized", order.join(",") === "A:bond-lock,A:settle,B:bond-lock,B:settle", order.join(","));
  await checkLedgers("after concurrent trades", [inv("investor1"), inv("investor2"), inv("investor3")]);

  console.log(failures === 0 ? "\nSUCCESS: rollback checks passed" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
