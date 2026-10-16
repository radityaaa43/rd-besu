/*
 * Task #13 live check (1 real new tx: propose only, no funds move -- propose() is pure
 * bookkeeping until recordLeg/createAtom/executeAtom much later): Agreement cache isolation
 * by (groupId, address), not address alone.
 *
 * Real incident: bank2-primary and bank3-primary onboarding agreements BOTH deployed to the
 * SAME address (0x1d42fff0...) -- confirmed live in task #12's own live check (the recovered
 * address for tx 1cb793b6, bank2's deploy) and via node1's own DB (bank2/bank3/bank4 primary
 * deploys' group salts, read directly).
 *
 * Proof: propose a real trade on bank2-primary's agreement, then query the SAME address under
 * BOTH bank2-primary's groupId (must see the real trade) and bank3-primary's groupId (must
 * see NOTHING -- a genuine on-chain TradeNotFound from that distinct private contract
 * instance, not just a client-cache miss, since both groups are explicitly resumed first).
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
// All confirmed directly against node1's own DB + task #12's own live-check output -- not guessed.
const COLLIDING_ADDRESS = "0x1d42fff09379521288b96f395210a1bf21c1cdf7";
const GROUP_BANK2 = "0xa4f83a48866fcf0b544551de779cfda8c11ae7e0cd3688a8809b597043e3b99a";
const GROUP_BANK3 = "0x23ba3e91bc863831a2da6d8face08813e2fc8119f835e1984521df34f29d4ef0";

async function main(): Promise<boolean> {
  const runId = Date.now();
  const bank1Cfg = loadClientConfigFile(`${OUT_DIR}/contract-data-bank1.json`, { nodeUrl: nodeConnections[0].clientOptions.url! });
  const biClient = await connectPaladinClient(bank1Cfg);
  const cashToken = (bank1Cfg.contractData as { cashToken: string }).cashToken;
  const investor2Lookup = "investor2@node2";
  const bondCustodianLookup = "bondCustodian@node1";

  // Resume BOTH colliding-address agreements explicitly -- so a lookup "miss" below is a real
  // on-chain TradeNotFound from that group's own distinct contract instance, not just "this
  // client never heard of this address" (which would prove nothing about the actual bug).
  await biClient.resumeAgreement(GROUP_BANK2, COLLIDING_ADDRESS);
  await biClient.resumeAgreement(GROUP_BANK3, COLLIDING_ADDRESS);

  const tradeId = `isolation-check:${runId}`;
  logger.log(`\n=== Proposing a real trade on bank2-primary's agreement (group ${GROUP_BANK2}) ===`);
  await biClient.proposeAgreement(GROUP_BANK2, COLLIDING_ADDRESS, tradeId, "ISOLATION_CHECK", [
    { asset: cashToken, from: bondCustodianLookup, to: investor2Lookup, amount: "1" },
  ]);
  logger.log(`tradeId=${tradeId}`);

  logger.log("\n=== Querying the SAME address under bank2-primary's groupId (must see the real trade) ===");
  const tradeFromBank2 = await biClient.getAgreement(GROUP_BANK2, COLLIDING_ADDRESS, tradeId);
  check("bank2-primary: getAgreement sees the real PROPOSED trade", tradeFromBank2.state === "PROPOSED" && tradeFromBank2.legs.length === 1, tradeFromBank2);

  logger.log("\n=== Querying the SAME address under bank3-primary's groupId (must see NOTHING -- isolation proof) ===");
  let bank3SawNothing = false;
  let bank3Error: string | undefined;
  try {
    await biClient.getAgreement(GROUP_BANK3, COLLIDING_ADDRESS, tradeId);
  } catch (e) {
    bank3SawNothing = true;
    bank3Error = (e as Error).message;
  }
  check(
    "bank3-primary: getAgreement on the SAME address does NOT see bank2's trade (real on-chain TradeNotFound, not a client-cache miss)",
    bank3SawNothing && (!!bank3Error?.includes("TradeNotFound") || !!bank3Error?.includes("reverted")),
    bank3Error
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
