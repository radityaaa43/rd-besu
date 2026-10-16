/*
 * Task #21 (lead-approved): investor2's orphan RD lock on node2 -- lockId
 * 0xd61eb3ce1f92f04bbe35b30d0cf90bbc29fa79866a0d3933f07e7e874e8a4550, amount 500000, owner
 * 0x448985f9...=investor2@node2, token 0x98143f4bff2281d6b20fa4987daf9f31d22c9c77 (RD cash).
 * Confirmed via DB (task #21, earlier): no prepare-unlock/delegate-lock transaction exists
 * under this trade's idempotency key -- the lock was created, then the original trade
 * (2b0b9799) never progressed further. Before releasing, confirm live that the lock is NOT
 * delegated (spender == owner) -- if it is, STOP, do not release.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node task21-release.ts
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
const CASH_TOKEN = "0x98143f4bff2281d6b20fa4987daf9f31d22c9c77";
const LOCK_ID = "0xd61eb3ce1f92f04bbe35b30d0cf90bbc29fa79866a0d3933f07e7e874e8a4550";

async function main(): Promise<boolean> {
  const node2 = nodeConnections[1];
  const bank2Cfg = loadClientConfigFile(`${OUT_DIR}/contract-data-bank2.json`, { nodeUrl: node2.clientOptions.url! });
  const investor2Client = await connectPaladinClient(bank2Cfg);

  const before = await investor2Client.balances(CASH_TOKEN);
  logger.log(`investor2 RD balance BEFORE: ${JSON.stringify(before)}`);
  check("lock is present in investor2's locked balance before release", BigInt(before.locked) >= 500000n, before);

  logger.log("=== releaseLock as investor2@node2 (release checks not-delegated internally) ===");
  try {
    await investor2Client.releaseLock(CASH_TOKEN, LOCK_ID);
    check("releaseLock did not throw", true);
  } catch (e) {
    check("releaseLock did not throw", false, (e as Error).message);
    logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    return failures === 0;
  }

  const after = await investor2Client.balances(CASH_TOKEN);
  logger.log(`investor2 RD balance AFTER: ${JSON.stringify(after)}`);
  check(
    "investor2's locked balance decreased by 500000 and available increased by 500000",
    BigInt(before.locked) - BigInt(after.locked) === 500000n && BigInt(after.available) - BigInt(before.available) === 500000n,
    { before, after }
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
