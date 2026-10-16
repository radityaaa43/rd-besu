/*
 * Task #17 live check. Fresh ephemeral group/identities/Noto token -- does NOT touch
 * bank1/bank2's active real-mode run.
 *
 * Real incident: a redelivered retry of prepareTradeLeg with the SAME idempotencyKey hit
 * prepareUnlock's PD_CLIENT_LOCK_ALREADY_PREPARED guard (a client-side pre-submit check) before
 * resolveIdempotentFuture's PD012220 recovery ever got a chance -- dead letter. Proof: calling
 * prepareTradeLeg twice with the SAME key returns the IDENTICAL result and creates exactly ONE
 * transaction (checked directly in node1's DB); calling prepareUnlock again on the SAME
 * already-prepared lock with a DIFFERENT key is still correctly rejected.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node retry-idempotency-live-check.ts
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
  const custodianName = `custR${runId}`;
  const sellerName = `sellerR${runId}`;
  const buyerName = `buyerR${runId}`;
  const custodianLookup = `${custodianName}@${node1}`;
  const sellerLookup = `${sellerName}@${node1}`;
  const buyerLookup = `${buyerName}@${node1}`;

  logger.log("=== Setup: ephemeral cash Noto token, minted to seller ===");
  const rawNode1 = new RawPaladinClient(nodeConnections[0].clientOptions);
  const [custodianVerifier] = rawNode1.getVerifiers(custodianLookup);
  const [sellerVerifier] = rawNode1.getVerifiers(sellerLookup);
  const cashNoto = await new NotoFactory(rawNode1, "noto")
    .newNoto(custodianVerifier, { name: `PTR${runId}`, symbol: "PTR", notary: custodianVerifier, notaryMode: "basic" })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashNoto) {
    check("ephemeral cash token deployed", false, "no contract returned");
    return false;
  }
  const cashToken = cashNoto.address;
  await cashNoto.mint(custodianVerifier, { to: sellerVerifier, amount: "1000", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);

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

  const { groupId } = await custodianClient.ensureOutrightGroup(sellerLookup, buyerLookup);
  const { agreementAddress } = await custodianClient.deployAgreement(groupId);
  await sellerClient.resumeAgreement(groupId, agreementAddress);
  await buyerClient.resumeAgreement(groupId, agreementAddress);

  const tradeId = `retry-check:${runId}`;
  await sellerClient.proposeAgreement(groupId, agreementAddress, tradeId, "TEST_LEG", [{ asset: cashToken, from: sellerLookup, to: buyerLookup, amount: "10" }]);
  await buyerClient.acceptAgreement(groupId, agreementAddress, tradeId);

  const idempotencyKey = `retry-check:${runId}:prepare`;
  logger.log("=== First call: prepareTradeLeg with a fresh idempotencyKey ===");
  const first = await sellerClient.prepareTradeLeg(groupId, agreementAddress, tradeId, 0, buyerLookup, idempotencyKey);
  logger.log(`first=${JSON.stringify(first)}`);

  const lockSubKey = `${idempotencyKey}:lock`;
  const prepareSubKey = `${idempotencyKey}:prepare`;
  const lockTxBefore = await rawNode1.ptx.getTransactionByIdempotencyKey(lockSubKey);
  const prepareTxBefore = await rawNode1.ptx.getTransactionByIdempotencyKey(prepareSubKey);

  logger.log("=== Second call: prepareTradeLeg again with the SAME idempotencyKey (simulates the redelivered retry) ===");
  const second = await sellerClient.prepareTradeLeg(groupId, agreementAddress, tradeId, 0, buyerLookup, idempotencyKey);
  logger.log(`second=${JSON.stringify(second)}`);

  check("second call did not throw PD_CLIENT_LOCK_ALREADY_PREPARED -- recovered instead", true, second);
  check("second call returns the IDENTICAL result as the first", JSON.stringify(second) === JSON.stringify(first), { first, second });

  const lockTxAfter = await rawNode1.ptx.getTransactionByIdempotencyKey(lockSubKey);
  const prepareTxAfter = await rawNode1.ptx.getTransactionByIdempotencyKey(prepareSubKey);
  check("0 new tx for the lock sub-step (same tx id before/after the retry)", lockTxBefore?.id === lockTxAfter?.id && !!lockTxAfter?.id, {
    before: lockTxBefore,
    after: lockTxAfter,
  });
  check("0 new tx for the prepare-unlock sub-step (same tx id before/after the retry)", prepareTxBefore?.id === prepareTxAfter?.id && !!prepareTxAfter?.id, {
    before: prepareTxBefore,
    after: prepareTxAfter,
  });

  logger.log("=== A DIFFERENT idempotencyKey on the SAME already-prepared lock must still be rejected ===");
  let rejectedCode: string | undefined;
  try {
    await sellerClient.prepareUnlock(cashToken, first.lockId, [{ to: buyerLookup, amount: "10" }], `${idempotencyKey}:a-genuinely-different-key`);
  } catch (e) {
    rejectedCode = (e as { code?: string }).code;
  }
  check("a different key on the same already-prepared lock is rejected with PD_CLIENT_LOCK_ALREADY_PREPARED", rejectedCode === "PD_CLIENT_LOCK_ALREADY_PREPARED", rejectedCode);

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
