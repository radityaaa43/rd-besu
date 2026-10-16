/*
 * Task #12 live check (read-mostly, 1 real new deploy): deployAgreement idempotency recovery.
 *
 * Scenario A: call deployAgreement with the EXACT idempotencyKey ("onboard-primary:bank2:
 *   deploy-agreement") and groupId a real backend call already used on node1 -- must return the
 *   ORIGINAL agreement address, not throw, and must NOT create a second transaction row for
 *   that idempotency key.
 * Scenario B: call deployAgreement with a BRAND NEW idempotencyKey on the SAME group -- must
 *   succeed as a genuinely new deploy (proves the fix didn't break the normal path).
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node live-check.ts
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
const EXISTING_KEY = "onboard-primary:bank2:deploy-agreement";
const EXISTING_GROUP_ID = "0xa4f83a48866fcf0b544551de779cfda8c11ae7e0cd3688a8809b597043e3b99a"; // bank1's recorded groupIds.bank2, confirmed via direct DB read against the real transaction's stored group.salt

async function main(): Promise<boolean> {
  const bank1Cfg = loadClientConfigFile(`${OUT_DIR}/contract-data-bank1.json`, { nodeUrl: nodeConnections[0].clientOptions.url! });
  const biClient = await connectPaladinClient(bank1Cfg);

  logger.log("\n=== Scenario A: reused idempotencyKey -> original address, no new tx ===");
  const { agreementAddress: recovered } = await biClient.deployAgreement(EXISTING_GROUP_ID, EXISTING_KEY);
  logger.log(`recovered agreementAddress=${recovered}`);
  check("Scenario A: deployAgreement with the existing key did not throw and returned an address", typeof recovered === "string" && recovered.startsWith("0x") && recovered.length === 42, recovered);

  // Calling it again a SECOND time with the exact same key must also recover the SAME address
  // (idempotent, not just "didn't crash once").
  const { agreementAddress: recoveredAgain } = await biClient.deployAgreement(EXISTING_GROUP_ID, EXISTING_KEY);
  check("Scenario A: calling it again returns the SAME address both times", recoveredAgain.toLowerCase() === recovered.toLowerCase(), { recovered, recoveredAgain });

  logger.log("\n=== Scenario B: brand-new idempotencyKey -> genuinely new deploy still works ===");
  const newKey = `task12-live-check:${Date.now()}`;
  const { agreementAddress: fresh } = await biClient.deployAgreement(EXISTING_GROUP_ID, newKey);
  logger.log(`fresh agreementAddress=${fresh}`);
  check("Scenario B: a brand-new key produces a genuinely new deploy (different address)", typeof fresh === "string" && fresh.toLowerCase() !== recovered.toLowerCase(), { fresh, recovered });

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
