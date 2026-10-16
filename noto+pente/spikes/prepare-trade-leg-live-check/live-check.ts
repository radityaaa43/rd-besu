/*
 * Task #15 live check. Fresh ephemeral group/identities/Noto token -- does NOT touch
 * bank1/bank2's active real-mode run or any existing group/contract-data.
 *
 * D2: the backend must never handle a leg's raw on-chain address. Proof: seller (the leg
 * owner) calls the NEW prepareTradeLeg(groupId, agreementAddress, tradeId, legIndex,
 * recipientLookup) with ONLY an identity lookup for the recipient -- never an address -- and
 * the returned {lockId, unlockCall, cancelCall, preparedStateId} is accepted by recordLeg.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node live-check.ts
 */
import RawPaladinClient, { NotoFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient } from "../../common/paladin-client/src/index";
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

async function main(): Promise<boolean> {
  const runId = Date.now();
  const node1 = nodeConnections[0].id;
  const custodianName = `custP${runId}`;
  const sellerName = `sellerP${runId}`;
  const buyerName = `buyerP${runId}`;
  const custodianLookup = `${custodianName}@${node1}`;
  const sellerLookup = `${sellerName}@${node1}`;
  const buyerLookup = `${buyerName}@${node1}`;

  logger.log("=== Setup: ephemeral cash Noto token, minted to seller ===");
  const rawNode1 = new RawPaladinClient(nodeConnections[0].clientOptions);
  const [custodianVerifier] = rawNode1.getVerifiers(custodianLookup);
  const [sellerVerifier] = rawNode1.getVerifiers(sellerLookup);
  const cashNoto = await new NotoFactory(rawNode1, "noto")
    .newNoto(custodianVerifier, { name: `PTL${runId}`, symbol: "PTL", notary: custodianVerifier, notaryMode: "basic" })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashNoto) {
    check("ephemeral cash token deployed", false, "no contract returned");
    return false;
  }
  const cashToken = cashNoto.address;
  const mintReceipt = await cashNoto.mint(custodianVerifier, { to: sellerVerifier, amount: "1000", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  check("minted 1000 to seller", !!mintReceipt?.success, mintReceipt);
  logger.log(`cashToken=${cashToken}`);

  const custodianClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    nodeId: node1,
    identity: custodianName,
    identities: { bondCustodian: custodianLookup },
  });
  const sellerClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    nodeId: node1,
    identity: sellerName,
  });
  const buyerClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    nodeId: node1,
    identity: buyerName,
  });

  logger.log("=== Fresh group + Agreement deploy ===");
  const { groupId } = await custodianClient.ensureOutrightGroup(sellerLookup, buyerLookup);
  logger.log(`groupId=${groupId}`);
  const { agreementAddress } = await custodianClient.deployAgreement(groupId);
  logger.log(`agreementAddress=${agreementAddress}`);
  await sellerClient.resumeAgreement(groupId, agreementAddress);
  await buyerClient.resumeAgreement(groupId, agreementAddress);

  const tradeId = `ptl-check:${runId}`;
  logger.log("=== propose (by seller) + accept (by buyer) ===");
  await sellerClient.proposeAgreement(groupId, agreementAddress, tradeId, "TEST_LEG", [{ asset: cashToken, from: sellerLookup, to: buyerLookup, amount: "10" }]);
  await buyerClient.acceptAgreement(groupId, agreementAddress, tradeId);

  logger.log("=== prepareTradeLeg (seller, identity ONLY -- never an address) ===");
  const prepared = await sellerClient.prepareTradeLeg(groupId, agreementAddress, tradeId, 0, buyerLookup);
  check("prepareTradeLeg returned a lockId/unlockCall/cancelCall/preparedStateId", !!(prepared.lockId && prepared.unlockCall && prepared.cancelCall && prepared.preparedStateId), prepared);

  logger.log("=== recordLeg accepts prepareTradeLeg's output ===");
  await sellerClient.recordLeg(groupId, agreementAddress, tradeId, 0, prepared.lockId, prepared.preparedStateId, prepared.unlockCall, prepared.cancelCall);

  const trade = await custodianClient.getAgreement(groupId, agreementAddress, tradeId);
  check("trade advanced to LEGS_PREPARED after recordLeg", trade.state === "LEGS_PREPARED", trade.state);
  check("leg.unlockCall is recorded on-chain (non-empty)", !!trade.legs[0].unlockCall && trade.legs[0].unlockCall !== "0x", trade.legs[0].unlockCall);
  check("leg.lockId on-chain matches what prepareTradeLeg returned", trade.legs[0].lockId?.toLowerCase() === prepared.lockId.toLowerCase(), { onChain: trade.legs[0].lockId, prepared: prepared.lockId });

  logger.log("=== mismatch guard: a DIFFERENT recipient must be refused before any lock is taken ===");
  const tradeId2 = `ptl-check-mismatch:${runId}`;
  await sellerClient.proposeAgreement(groupId, agreementAddress, tradeId2, "TEST_LEG", [{ asset: cashToken, from: sellerLookup, to: buyerLookup, amount: "5" }]);
  await buyerClient.acceptAgreement(groupId, agreementAddress, tradeId2);
  let mismatchCode: string | undefined;
  let mismatchMsg: string | undefined;
  try {
    await sellerClient.prepareTradeLeg(groupId, agreementAddress, tradeId2, 0, custodianLookup);
  } catch (e) {
    mismatchCode = (e as { code?: string }).code;
    mismatchMsg = (e as Error).message;
  }
  check("prepareTradeLeg refuses a recipientLookup that doesn't match the on-chain leg.to", mismatchCode === "PD_CLIENT_LEG_MISMATCH", { code: mismatchCode, message: mismatchMsg });

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
