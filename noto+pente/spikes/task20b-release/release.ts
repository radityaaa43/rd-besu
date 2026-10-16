/*
 * Task #20-B (lead-approved, 2026-10-06): on series 0xd56fe21a... (bond token), bondCustodian's
 * own bond leg lock (lockId 0xc533121c..., amount 3000) has been stuck since before the 0.5.4
 * fix -- releaseLock-to-self failed with "Investor is not registered" because the custodian was
 * never registered on its own series' InvestorList.
 *
 * Confirmed live facts (DB, read-only, before this script): groupId
 * e57210e05a7a24b925d411c541ab8be0aa0559abb96146eccf2db7a86ff196e9 hosts BondTracker at
 * 15db0b173cd8804c7b37d7a3aaa306b6e4409978 (matched via the BondTracker deploy tx's genesis_tx);
 * the lock state (amount 3000, owner 0xbbab6f95...=bondCustodian@node1) is still unspent.
 *
 * Steps: (1) resolve InvestorList's real address via a live pgroup_call to BondTracker
 * (investorList() public getter) -- not guessed; (2) bondCustodian@node1 calls
 * addInvestor(custodianAddress) directly on that InvestorList, within the same group;
 * (3) bondCustodian@node1 calls releaseLock on the bond token for the stuck lock.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node release.ts
 */
import RawPaladinClient, { PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, loadClientConfigFile } from "../../common/paladin-client/src/index";
import type { PaladinClient as PaladinClientWrapper } from "../../common/paladin-client/src/types";

const logger = console;
let failures = 0;
function check(label: string, pass: boolean, detail?: unknown) {
  if (pass) {
    console.log(`OK   - ${label}`);
  } else {
    failures++;
    console.error(`FAIL - ${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

const OUT_DIR = "/home/ecs-user/alibaba-kube/Paladin/bootstrap/out";
const GROUP_ID = "0xe57210e05a7a24b925d411c541ab8be0aa0559abb96146eccf2db7a86ff196e9";
// BondTracker's address WITHIN the group's private EVM -- NOT the group's own outer/base-ledger
// address (0x15db0b17..., which is what pgroup_getGroupById's own `contractAddress` field shows
// and what every state's outer `contractAddress` field shows too -- both are the GROUP's
// address, same for every account inside it; the REAL per-contract address only shows up in a
// state's INNER `data.address` field, or by brute-force probing candidates, which is how this
// was actually found: 3 candidate inner addresses from the receipt, called investorList() on
// each, only this one returned a real address instead of reverting).
const BOND_TRACKER_ADDRESS = "0x900bb5b2043366f2bb3ee1e7c79a0eef793ae284";
const BOND_TOKEN = "0xd56fe21a3fe25583a29b878ef4ccb0a51cc5f48a";
const STUCK_LOCK_ID = "0xc533121c88b4189b9275a7679f9442122f02ab6416a67e6231bf61fcc6ff4601";

async function main(): Promise<boolean> {
  const node1 = nodeConnections[0];
  const bank1Cfg = loadClientConfigFile(`${OUT_DIR}/contract-data-bank1.json`, { nodeUrl: node1.clientOptions.url! });
  const custodianClient: PaladinClientWrapper = await connectPaladinClient(bank1Cfg);

  logger.log("=== Step 1: resolve InvestorList's real address via a live call to BondTracker ===");
  const rawNode1 = new RawPaladinClient(node1.clientOptions);
  const group = await new PenteFactory(rawNode1, "pente").resumePrivacyGroup({ id: GROUP_ID });
  if (!group) {
    check("resumed the issuer+custodian privacy group", false, "resumePrivacyGroup returned null");
    return false;
  }
  const investorListResult = (await group.call({
    to: BOND_TRACKER_ADDRESS,
    methodAbi: { type: "function", name: "investorList", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    from: "bondCustodian@node1",
    data: [],
  })) as any;
  const investorListAddress = (investorListResult["0"] ?? investorListResult) as string;
  const normalizedInvestorList = investorListAddress.startsWith("0x") ? investorListAddress : `0x${investorListAddress}`;
  logger.log(`investorListAddress=${normalizedInvestorList}`);
  check("resolved a real InvestorList address", normalizedInvestorList.length === 42, normalizedInvestorList);

  const custodianAddress = (await rawNode1.getVerifiers("bondCustodian@node1")[0].address()).toLowerCase();
  logger.log(`custodianAddress=${custodianAddress}`);

  logger.log("=== Check: is the custodian already registered? ===");
  const alreadyRegisteredResult = (await group.call({
    to: normalizedInvestorList,
    methodAbi: { type: "function", name: "isRegistered", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
    from: "bondCustodian@node1",
    data: [custodianAddress],
  })) as any;
  const alreadyRegistered = (alreadyRegisteredResult["0"] ?? alreadyRegisteredResult) === true;
  logger.log(`alreadyRegistered=${alreadyRegistered}`);

  if (!alreadyRegistered) {
    logger.log("=== Step 2: bondCustodian@node1 calls addInvestor(custodianAddress) ===");
    const receipt = await group
      .sendTransaction({
        from: "bondCustodian@node1",
        to: normalizedInvestorList,
        methodAbi: { type: "function", name: "addInvestor", inputs: [{ type: "address", name: "addr" }], outputs: [] },
        data: [custodianAddress],
      })
      .waitForReceipt(60000);
    check("addInvestor succeeded", !!receipt?.success, receipt);
    logger.log(`addInvestor txHash=${receipt?.transactionHash}`);
  } else {
    check("addInvestor skipped -- custodian already registered (idempotent re-run)", true);
  }

  logger.log("=== Step 3: releaseLock the stuck bond leg lock as bondCustodian@node1 ===");
  const custodianBefore = await custodianClient.balances(BOND_TOKEN);
  logger.log(`custodian bond balance BEFORE: ${JSON.stringify(custodianBefore)}`);

  try {
    await custodianClient.releaseLock(BOND_TOKEN, STUCK_LOCK_ID);
    check("releaseLock did not throw", true);
  } catch (e) {
    check("releaseLock did not throw", false, (e as Error).message);
  }

  const custodianAfter = await custodianClient.balances(BOND_TOKEN);
  logger.log(`custodian bond balance AFTER: ${JSON.stringify(custodianAfter)}`);
  check(
    "custodian's locked balance decreased by 3000 and available increased by 3000",
    BigInt(custodianBefore.locked) - BigInt(custodianAfter.locked) === 3000n && BigInt(custodianAfter.available) - BigInt(custodianBefore.available) === 3000n,
    { before: custodianBefore, after: custodianAfter }
  );

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
