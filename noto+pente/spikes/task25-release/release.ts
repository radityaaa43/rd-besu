/*
 * Task #25-C (lead GO, 2026-10-07): 3 orphaned bond locks on SRBI
 * (0x2b4cbd5a6bc005a1fc695519dd983c3af0c4d20b), each 300 units, owner bondCustodian@node1.
 * Created by lockToken during E5 attempt 1's prepareTradeLeg (trades ed723768/ad6ebca1/37fa627f),
 * then prepareUnlock reverted "Investor is not registered" (recipient investor never added to
 * the series' InvestorList -- confirmed read-only in task #25-A, DB + timestamp match).
 *
 * Fixed going forward by 0.6.5 (pre-flight whitelist check + auto-compensating-release). These
 * 3 are pre-existing orphans from before that fix shipped -- released here directly as
 * bondCustodian@node1 (lock owner), one at a time per lead's instruction. D20's `to ==
 * _custodian` on-chain exemption makes a self-release succeed regardless of InvestorList state.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node release.ts
 */
import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, loadClientConfigFile } from "../../common/paladin-client/src/index";

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
const BOND_TOKEN = "0x2b4cbd5a6bc005a1fc695519dd983c3af0c4d20b";
const LOCKS: { tradeId: string; lockId: string }[] = [
  { tradeId: "ed723768-c3fd-4c1d-b41f-5e1c30436698", lockId: "0xfa39a42cc91229acefe192733087c8dcccf19c82bd4a2e1c8dc40f9d38f4df74" },
  { tradeId: "ad6ebca1-67c6-4e7b-8bc2-a50316c17fd9", lockId: "0x81cabda0b4ce1ba4b8f3fa1413ef5814961d63402b1aa230fbe1bd7453fa90f5" },
  { tradeId: "37fa627f-8076-48dc-911c-0a07c1225fc5", lockId: "0x94dbb27ea0899608edd62d1c39d127b9a2fd7a8fc65af595d98e12c6e66ff7a1" },
];

async function main(): Promise<boolean> {
  const node1 = nodeConnections[0];
  const bank1Cfg = loadClientConfigFile(`${OUT_DIR}/contract-data-bank1.json`, { nodeUrl: node1.clientOptions.url! });
  const custodianClient = await connectPaladinClient(bank1Cfg);

  for (const { tradeId, lockId } of LOCKS) {
    logger.log(`\n=== Releasing lock for trade ${tradeId} (lockId ${lockId}) ===`);
    const before = await custodianClient.balances(BOND_TOKEN);
    logger.log(`custodian SRBI balance BEFORE: ${JSON.stringify(before)}`);

    try {
      await custodianClient.releaseLock(BOND_TOKEN, lockId, undefined, "bondCustodian");
      check(`releaseLock(${lockId}) did not throw`, true);
    } catch (e) {
      check(`releaseLock(${lockId}) did not throw`, false, (e as Error).message);
      logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
      return failures === 0;
    }

    const after = await custodianClient.balances(BOND_TOKEN);
    logger.log(`custodian SRBI balance AFTER: ${JSON.stringify(after)}`);
    check(
      `custodian's locked balance decreased by 300 and available increased by 300 (lock ${lockId})`,
      BigInt(before.locked) - BigInt(after.locked) === 300n && BigInt(after.available) - BigInt(before.available) === 300n,
      { before, after }
    );
  }

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
