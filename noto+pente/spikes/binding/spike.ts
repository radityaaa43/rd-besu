/*
 * Spike for lead task #5: prove BI can bind lockId -> the prepared unlock on-chain -> outputs ==
 * preparedStateId, so a buyer cannot submit a different unlockCall than the one that really
 * corresponds to the lock BI expects.
 *
 * Two binding checks, both independently verified live:
 * 1. lockId binding: `unlockCall` is the ABI-encoded calldata for Noto's base-ledger
 *    `spendLock(bytes32 lockId, bytes spendArgs, bytes data)` (confirmed via INoto.json) --
 *    its FIRST parameter IS the lockId being spent. BI decodes the unlockCall a buyer hands
 *    over and checks its embedded lockId against the lockId BI actually expects for this
 *    subscription. A buyer who swaps in a DIFFERENT unlockCall (from an unrelated lock) is
 *    caught here, before BI ever builds an Atom around it.
 * 2. preparedStateId/output binding: the task #3 correlation mechanism
 *    (domainReceipt.states.preparedOutputs[].id) cross-checked against BI's own
 *    pstate_queryContractStates read -- catches a buyer who claims the right lockId but a
 *    stale/wrong preparedStateId (e.g. for a different amount).
 *
 * Also verifies the 0.2.1 client-side ownership guard live: an identity that does NOT own a
 * lock calling delegateLock on it must be refused BEFORE any transaction reaches the node
 * (PD_CLIENT_LOCK_OWNER_MISMATCH, receiptless count unaffected).
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node spike.ts
 */
import PaladinClient, { INotoDomainReceipt, NotoFactory, PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { newERC20Tracker } from "../../bond/src/helpers/erc20tracker";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, PaladinClient as PaladinClientPort } from "../../common/paladin-client/src/index";
import INotoJson from "../../bond/node_modules/@lfdecentralizedtrust/paladin-sdk/build/domains/abis/INoto.json";

const logger = console;
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// BI's own binding check -- would live in the backend, not paladin-client, since it's a
// business-logic policy decision (reject before building an atom), not a generic SDK op.
function decodeLockIdFromUnlockCall(unlockCall: string): string {
  const iface = new ethers.Interface(INotoJson.abi);
  const decoded = iface.decodeFunctionData("spendLock", unlockCall);
  return decoded[0] as string; // spendLock(bytes32 lockId, bytes spendArgs, bytes data)
}

async function main(): Promise<boolean> {
  if (nodeConnections.length < 4) {
    logger.error("Need 4 nodes configured.");
    return false;
  }
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const bi = clients[0];
  const buyerClient = clients[2];
  const sellerClient = clients[1];
  const runId = Date.now();
  const [cashIssuer] = bi.getVerifiers(`bindCashIssuer${runId}@${nodeConnections[0].id}`);
  const [buyer] = buyerClient.getVerifiers(`bindBuyer${runId}@${nodeConnections[2].id}`);
  const [seller] = sellerClient.getVerifiers(`bindSeller${runId}@${nodeConnections[1].id}`);
  const [attacker] = buyerClient.getVerifiers(`bindAttacker${runId}@${nodeConnections[2].id}`);

  logger.log("=== Deploying scratch hooks-mode cash token (BI is notary) ===");
  const penteFactory = new PenteFactory(bi, "pente");
  const cashGroup = await penteFactory
    .newPrivacyGroup({ members: [cashIssuer], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashGroup) return false;
  const cashTracker = await newERC20Tracker(cashGroup, cashIssuer, { name: "BINDCASH", symbol: "BIND" });
  if (!cashTracker) return false;
  const notoCash = await new NotoFactory(bi, "noto")
    .newNoto(cashIssuer, {
      name: "BINDCASH",
      symbol: "BIND",
      notary: cashIssuer,
      notaryMode: "hooks",
      options: { hooks: { privateGroup: cashGroup, publicAddress: cashGroup.address, privateAddress: cashTracker.address } },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!notoCash) return false;
  logger.log(`notoCash=${notoCash.address}`);

  let r = await notoCash.mint(cashIssuer, { to: buyer, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return false;
  r = await notoCash.mint(cashIssuer, { to: attacker, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return false;

  const schemas = await bi.pstate.listSchemas("noto");
  const coinSchema = schemas.find((s) => (s.definition as { name?: string }).name === "NotoCoin");
  if (!coinSchema) {
    logger.error("NotoCoin schema not found on BI's node");
    return false;
  }

  // lockAndPrepare, always signed by the LOCK OWNER's own client (mandatory live discipline).
  const lockAndPrepare = async (label: string, ownerClient: PaladinClient, owner: any, amount: number, to: any) => {
    let rr = await notoCash.using(ownerClient).lock(owner, { amount: String(amount), data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!rr?.success) throw new Error(`${label}: lock failed`);
    const lockId = (rr.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.lockId;
    if (!lockId) throw new Error(`${label}: no lockId`);

    rr = await notoCash
      .using(ownerClient)
      .prepareUnlock(owner, { lockId, from: owner, recipients: [{ to, amount: String(amount) }], unlockData: "0x", data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!rr?.success) throw new Error(`${label}: prepareUnlock failed`);
    const domainReceipt = rr.domainReceipt as INotoDomainReceipt | undefined;
    const unlockCall = domainReceipt?.lockInfo?.unlockCall;
    if (!unlockCall) throw new Error(`${label}: no unlockCall`);
    const toAddr = await to.address();
    const preparedOutputs = (domainReceipt as any)?.states?.preparedOutputs as { id: string; data: { owner: string; amount: string } }[] | undefined;
    const ourOutput = preparedOutputs?.find((o) => o.data.owner.toLowerCase() === toAddr.toLowerCase());
    if (!ourOutput) throw new Error(`${label}: no preparedOutputs entry for recipient in receipt`);
    logger.log(`[${label}] lockId=${lockId} preparedOutput.id=${ourOutput.id} amount=${ourOutput.data.amount}`);
    return { lockId, unlockCall, preparedStateId: ourOutput.id, amount };
  };

  // === Legit case: buyer locks 70 to seller ===
  const legit = await lockAndPrepare("legit", buyerClient, buyer, 70, seller);

  // === Attack prep: a completely UNRELATED lock, different owner, different amount, different
  // recipient -- the thing a malicious/buggy buyer might swap in instead of their real unlockCall. ===
  const unrelated = await lockAndPrepare("unrelated", buyerClient, attacker, 999, seller);

  // === BI's binding check function ===
  const biVerifyBinding = async (
    expectedLockId: string,
    expectedAmount: number,
    expectedRecipientAddr: string,
    claimedUnlockCall: string,
    claimedPreparedStateId: string
  ): Promise<{ ok: boolean; reason?: string }> => {
    // Check 1: lockId binding -- decode the unlockCall, compare its embedded lockId.
    let decodedLockId: string;
    try {
      decodedLockId = decodeLockIdFromUnlockCall(claimedUnlockCall);
    } catch (e) {
      return { ok: false, reason: `unlockCall does not decode as spendLock: ${(e as Error).message}` };
    }
    if (decodedLockId.toLowerCase() !== expectedLockId.toLowerCase()) {
      return { ok: false, reason: `unlockCall's embedded lockId ${decodedLockId} != expected ${expectedLockId}` };
    }
    // Check 2: preparedStateId/output binding -- the claimed output must actually exist
    // on-chain, with the right owner and amount, per the task #3 correlation mechanism.
    const states = await bi.pstate.queryContractStates("noto", notoCash.address, coinSchema!.id, { eq: [{ field: "owner", value: expectedRecipientAddr }] }, "all");
    const match = states.find((s) => s.id === claimedPreparedStateId);
    if (!match) return { ok: false, reason: `preparedStateId ${claimedPreparedStateId} does not match any real state owned by ${expectedRecipientAddr}` };
    if ((match.data as { amount: string }).amount !== String(expectedAmount)) {
      return { ok: false, reason: `matched state's amount ${(match.data as any).amount} != expected ${expectedAmount}` };
    }
    return { ok: true };
  };

  await sleep(2000); // let state confirmations land before BI queries.
  const sellerAddr = await seller.address();

  // === Positive case: BI checks the REAL unlockCall/preparedStateId for legit's own lock. ===
  const okResult = await biVerifyBinding(legit.lockId, legit.amount, sellerAddr, legit.unlockCall, legit.preparedStateId);
  check("legit unlockCall/preparedStateId binds correctly", okResult.ok, JSON.stringify(okResult));

  // === Attack 1: buyer hands BI the UNRELATED lock's unlockCall, claiming it's for legit's
  // lockId -- a buyer trying to substitute a different lock's spend for the one BI expects. ===
  const attack1 = await biVerifyBinding(legit.lockId, legit.amount, sellerAddr, unrelated.unlockCall, unrelated.preparedStateId);
  check("swapped unlockCall (different lock) is REJECTED by lockId binding", !attack1.ok && !!attack1.reason?.includes("embedded lockId"), JSON.stringify(attack1));

  // === Attack 2: buyer hands BI the REAL unlockCall for legit's own lockId (so check 1 passes),
  // but claims a MISMATCHED (unrelated) preparedStateId -- e.g. trying to claim a bigger prior
  // prepared amount under cover of the real lockId. ===
  const attack2 = await biVerifyBinding(legit.lockId, legit.amount, sellerAddr, legit.unlockCall, unrelated.preparedStateId);
  check("real lockId but mismatched preparedStateId is REJECTED by output binding", !attack2.ok, JSON.stringify(attack2));

  // === Attack 3: a syntactically well-formed but never-produced preparedStateId (pure fabrication). ===
  const bogusStateId = "0x" + "cd".repeat(32);
  const attack3 = await biVerifyBinding(legit.lockId, legit.amount, sellerAddr, legit.unlockCall, bogusStateId);
  check("fabricated preparedStateId (never produced) is REJECTED", !attack3.ok, JSON.stringify(attack3));

  // ===================================================================================
  // Live verification of the 0.2.1 client-side ownership guard (lead requirement): a
  // delegateLock from an identity that does NOT own the lock must be refused client-side,
  // BEFORE any transaction reaches the node.
  // ===================================================================================
  logger.log("\n=== Verifying the 0.2.1 verifyLockOwner guard live ===");
  const wrongIdentityClient = await connectPaladinClient({
    nodeUrl: nodeConnections[2].clientOptions.url,
    wsUrl: nodeConnections[2].clientOptions.url.replace(/^http/, "ws").replace(/(\d+)$/, (p) => String(Number(p) + 1)),
    nodeId: nodeConnections[2].id,
    identity: `bindWrongIdentity${runId}`, // NOT the owner of legit.lockId (buyer is).
  });
  let guardThrew = false;
  let guardErrorCode: string | undefined;
  try {
    await wrongIdentityClient.delegateLock(notoCash.address, legit.lockId, await seller.address());
  } catch (e) {
    guardThrew = true;
    guardErrorCode = (e as { code?: string }).code;
  }
  check(
    "delegateLock from the WRONG identity is refused client-side with PD_CLIENT_LOCK_OWNER_MISMATCH",
    guardThrew && guardErrorCode === "PD_CLIENT_LOCK_OWNER_MISMATCH",
    `threw=${guardThrew}, code=${guardErrorCode}`
  );
  await wrongIdentityClient.disconnect();

  // Positive control: the SAME delegateLock, from the ACTUAL owner (buyer), must be allowed
  // through the guard (though we don't need it to actually settle anything for this spike).
  const buyerPaladinClient: PaladinClientPort = await connectPaladinClient({
    nodeUrl: nodeConnections[2].clientOptions.url,
    wsUrl: nodeConnections[2].clientOptions.url.replace(/^http/, "ws").replace(/(\d+)$/, (p) => String(Number(p) + 1)),
    nodeId: nodeConnections[2].id,
    identity: `bindBuyer${runId}`, // SAME local name used for `buyer` above -- genuinely the owner.
  });
  let ownerGuardPassed = true;
  let ownerGuardError: string | undefined;
  try {
    await buyerPaladinClient.delegateLock(notoCash.address, legit.lockId, await seller.address());
  } catch (e) {
    ownerGuardPassed = false;
    ownerGuardError = (e as { message?: string }).message;
  }
  check("delegateLock from the REAL owner passes the guard (not blocked)", ownerGuardPassed, ownerGuardError ?? "no error");
  await buyerPaladinClient.disconnect();

  console.log(failures === 0 ? "\nSUCCESS: binding checks + 0.2.1 guard verified live" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
