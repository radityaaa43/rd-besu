/*
 * Spike for lead task #5b: close the gap the lead found in #5's binding spike. #5 only checked
 * (1) the unlockCall's embedded lockId matches, and (2) a CLAIMED preparedStateId resolves to a
 * real state with the right owner/amount -- but never verified that the outputs the unlockCall
 * will ACTUALLY produce (encoded inside spendArgs) are the ones BI agreed to. The open attack:
 * buyer shows BI a good preparedStateId S1 (70 to seller), then re-prepares the SAME lock to
 * S2 (40 to seller, 60 back to buyer) and hands BI/the atom the S2 unlockCall instead.
 *
 * Two things proven live, in order:
 *
 * A. CAN the lock owner re-prepareUnlock after delegating? Answer, found in
 *    solidity/contracts/domains/noto/Noto.sol:477-479 (`updateLock`, which `prepareUnlock`
 *    calls on-chain): `if (lock.owner != lock.spender) revert LockImmutable(lockId);` --
 *    delegateLock sets `spender = delegate`, so ANY updateLock (re-prepare) attempt after
 *    delegation reverts. The lock becomes immutable the moment it's delegated. This means BI's
 *    verification is safe at ANY point after delegation (not specifically "right before
 *    execute") -- but MUST be after delegation, never only at prepare time, since re-prepare
 *    before delegation is exactly the open attack. Proven live below (attack prep step).
 *
 * B. BI's real binding check: decode `spendArgs` out of the unlockCall
 *    (spendLock(bytes32 lockId, bytes spendArgs, bytes data) -- spendArgs itself ABI-decodes as
 *    NotoSpendLockArgs{bytes32 txId, bytes32[] inputs, bytes32[] outputs, bytes data, bytes
 *    proof}, confirmed via domains/noto/pkg/types/abi.go:343-354 and
 *    internal/noto/handler_unlock.go:203-210). `outputs` is the REAL, ENFORCED list of state
 *    ids this call will produce when it executes (Noto.sol's spendLock decodes spendArgs the
 *    same way and checks it against `lock.spendCommitment`, which was frozen at delegation).
 *    BI reads each output from its own node, and the check passes only if:
 *      - every output in the decoded list is a real state (found on BI's node)
 *      - the total going to the expected recipient == the expected amount
 *      - every OTHER output belongs only to the lock owner (legitimate change), never a
 *        third party
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node spike.ts
 */
import PaladinClient, { INotoDomainReceipt, NotoFactory, PenteFactory, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { newERC20Tracker } from "../../bond/src/helpers/erc20tracker";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";
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

const NOTO_SPEND_LOCK_ARGS_TUPLE = "tuple(bytes32 txId, bytes32[] inputs, bytes32[] outputs, bytes data, bytes proof)";

function decodeSpendLockOutputs(unlockCall: string): string[] {
  const iface = new ethers.Interface(INotoJson.abi);
  const [, spendArgs] = iface.decodeFunctionData("spendLock", unlockCall);
  const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode([NOTO_SPEND_LOCK_ARGS_TUPLE], spendArgs);
  return (decoded.outputs as string[]).map((o) => o.toLowerCase());
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
  const [cashIssuer] = bi.getVerifiers(`b5bCashIssuer${runId}@${nodeConnections[0].id}`);
  const [buyer] = buyerClient.getVerifiers(`b5bBuyer${runId}@${nodeConnections[2].id}`);
  const [seller] = sellerClient.getVerifiers(`b5bSeller${runId}@${nodeConnections[1].id}`);
  const [biAtomStandIn] = bi.getVerifiers(`b5bAtom${runId}@${nodeConnections[0].id}`); // acts as the delegate/"atom" for this spike

  logger.log("=== Deploying scratch hooks-mode cash token (BI is notary) ===");
  const penteFactory = new PenteFactory(bi, "pente");
  const cashGroup = await penteFactory
    .newPrivacyGroup({ members: [cashIssuer], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashGroup) return false;
  const cashTracker = await newERC20Tracker(cashGroup, cashIssuer, { name: "B5BCASH", symbol: "B5B" });
  if (!cashTracker) return false;
  const notoCash = await new NotoFactory(bi, "noto")
    .newNoto(cashIssuer, {
      name: "B5BCASH",
      symbol: "B5B",
      notary: cashIssuer,
      notaryMode: "hooks",
      options: { hooks: { privateGroup: cashGroup, publicAddress: cashGroup.address, privateAddress: cashTracker.address } },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!notoCash) return false;
  logger.log(`notoCash=${notoCash.address}`);

  let r = await notoCash.mint(cashIssuer, { to: buyer, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return false;

  const schemas = await bi.pstate.listSchemas("noto");
  const coinSchema = schemas.find((s) => (s.definition as { name?: string }).name === "NotoCoin");
  if (!coinSchema) {
    logger.error("NotoCoin schema not found");
    return false;
  }

  const prepareOnce = async (lockId: string, sellerAmount: number, changeAmount: number) => {
    const rr = await notoCash
      .using(buyerClient)
      .prepareUnlock(buyer, {
        lockId,
        from: buyer,
        recipients: [
          { to: seller, amount: String(sellerAmount) },
          { to: buyer, amount: String(changeAmount) },
        ],
        unlockData: "0x",
        data: "0x",
      })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    return rr;
  };

  // === Buyer locks 100, creates the lock ===
  let r2 = await notoCash.using(buyerClient).lock(buyer, { amount: "100", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
  if (!r2?.success) return false;
  const lockId = (r2.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.lockId;
  if (!lockId) return false;
  logger.log(`lockId=${lockId}`);

  // === Prepare #1 (the "agreed" deal BI is shown): 70 to seller, 30 change back to buyer ===
  const prep1 = await prepareOnce(lockId, 70, 30);
  check("prepare #1 (70/30) succeeds", !!prep1?.success, JSON.stringify({ success: prep1?.success, failureMessage: prep1?.failureMessage }));
  const unlockCall1 = (prep1!.domainReceipt as INotoDomainReceipt).lockInfo!.unlockCall!;

  // === ATTACK PREP: buyer re-prepares the SAME lock BEFORE delegating -- a worse deal: 40 to
  // seller, 60 change back to buyer. This must succeed (lock not yet delegated, still mutable). ===
  const prep2 = await prepareOnce(lockId, 40, 60);
  check("re-prepare BEFORE delegation (40/60, the attack attempt) succeeds -- lock still mutable pre-delegation", !!prep2?.success, JSON.stringify({ success: prep2?.success, failureMessage: prep2?.failureMessage }));
  const unlockCall2 = (prep2!.domainReceipt as INotoDomainReceipt).lockInfo!.unlockCall!;

  // === Delegate the lock to "the atom" (biAtomStandIn) -- this should freeze spendCommitment
  // to whatever was MOST RECENTLY prepared (unlockCall2, the 40/60 attack version). ===
  const atomAddr = await biAtomStandIn.address();
  const delegateReceipt = await notoCash.using(buyerClient).delegateLock(buyer, { lockId, delegate: atomAddr, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  check("delegateLock succeeds", !!delegateReceipt?.success, JSON.stringify({ success: delegateReceipt?.success, failureMessage: delegateReceipt?.failureMessage }));

  // === PROOF A: re-prepare AFTER delegation must now REVERT (LockImmutable). An assemble/
  // execution-time revert like this never sets `success` at all (confirmed pattern throughout
  // this session, e.g. task #7) -- it only sets `failureMessage`. `success !== true` is the
  // only thing that means "did not revert". ===
  const prep3 = await prepareOnce(lockId, 50, 50);
  check(
    "re-prepare AFTER delegation is REJECTED (lock is now immutable, LockImmutable)",
    prep3?.success !== true && !!prep3?.failureMessage?.includes("LockImmutable"),
    JSON.stringify({ success: prep3?.success, failureMessage: prep3?.failureMessage })
  );

  // === getLock view call: confirm spender != owner (delegated), read directly from the base
  // Noto contract, not inferred from receipts. ===
  const buyerAddr = await buyer.address();
  const lockInfoResult = await bi.ptx.call({
    type: TransactionType.PUBLIC,
    abi: INotoJson.abi,
    function: "getLock",
    to: notoCash.address,
    from: cashIssuer.lookup,
    data: { lockId },
  });
  // Named single tuple output -- keyed by its ABI output name ("info"), not index "0" (unlike
  // the unnamed-getter outputs elsewhere in this session, e.g. BondTrackerPublic.status()).
  const lockInfo = (lockInfoResult as any).info ?? (lockInfoResult as any)["0"];
  // ptx_call returns address-typed fields WITHOUT a "0x" prefix (confirmed live) -- normalize
  // both sides before comparing.
  const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();
  // Note: lockInfo.owner is NOT buyer.address() directly in hooks mode -- the base-ledger
  // "owner" recorded by a hooks-mode lock is the Pente group's own representative address, not
  // the individual identity's address (a hooks-mode indirection, not a bug). Irrelevant to what
  // this check needs to prove, so not asserted against buyerAddr -- only that delegation moved
  // spender away from owner, and specifically to the expected delegate.
  check(
    "getLock confirms lock is delegated (spender != owner, spender == the expected delegate)",
    norm(lockInfo.spender) === norm(atomAddr) && norm(lockInfo.spender) !== norm(lockInfo.owner),
    JSON.stringify({ lockInfo, atomAddr })
  );

  await sleep(2000);
  const sellerAddr = await seller.address();

  // === BI's real binding check: decode outputs from the ACTUAL unlockCall, read them from
  // BI's own node, and verify total-to-recipient + change-only-to-owner. ===
  const biVerifyOutputs = async (unlockCall: string, expectedRecipientAddr: string, expectedAmount: number, expectedOwnerAddr: string): Promise<{ ok: boolean; reason?: string }> => {
    let outputs: string[];
    try {
      outputs = decodeSpendLockOutputs(unlockCall);
    } catch (e) {
      return { ok: false, reason: `could not decode spendArgs: ${(e as Error).message}` };
    }
    const recipientStates = await bi.pstate.queryContractStates("noto", notoCash.address, coinSchema!.id, { eq: [{ field: "owner", value: expectedRecipientAddr }] }, "all");
    const ownerStates = await bi.pstate.queryContractStates("noto", notoCash.address, coinSchema!.id, { eq: [{ field: "owner", value: expectedOwnerAddr }] }, "all");
    const byId = new Map<string, { data: { owner: string; amount: string } }>();
    for (const s of [...recipientStates, ...ownerStates]) byId.set(s.id, s as any);

    let totalToRecipient = 0;
    for (const outId of outputs) {
      const state = byId.get(outId);
      if (!state) return { ok: false, reason: `output ${outId} is not a known state owned by the recipient or the lock owner -- could be going to a THIRD PARTY` };
      const owner = state.data.owner.toLowerCase();
      if (owner === expectedRecipientAddr.toLowerCase()) {
        totalToRecipient += Number(state.data.amount);
      } else if (owner !== expectedOwnerAddr.toLowerCase()) {
        return { ok: false, reason: `output ${outId} belongs to ${owner}, neither the expected recipient nor the lock owner` };
      }
      // else: legitimate change back to the lock owner, fine.
    }
    if (totalToRecipient !== expectedAmount) {
      return { ok: false, reason: `total to recipient ${totalToRecipient} != expected ${expectedAmount}` };
    }
    return { ok: true };
  };

  // The lock is now delegated and immutable with unlockCall2's (40/60) terms baked in --
  // confirmed by proof A above. BI's check, reading the REAL (post-delegation) unlockCall,
  // must catch that it does NOT match the originally agreed 70.
  const checkAgainstAgreedDeal = await biVerifyOutputs(unlockCall2, sellerAddr, 70, buyerAddr);
  check(
    "BI's binding check REJECTS the delegated (attack) unlockCall against the originally agreed amount (70)",
    !checkAgainstAgreedDeal.ok,
    JSON.stringify(checkAgainstAgreedDeal)
  );

  // Sanity: if BI instead checks against what was ACTUALLY delegated (40), the check passes --
  // proving the check function itself is correct, not just permanently broken.
  const checkAgainstActualDeal = await biVerifyOutputs(unlockCall2, sellerAddr, 40, buyerAddr);
  check("BI's binding check ACCEPTS when checked against the actually-delegated amount (40)", checkAgainstActualDeal.ok, JSON.stringify(checkAgainstActualDeal));

  // Also prove unlockCall1 (the one BI was originally shown, 70/30) is now STALE -- its outputs
  // reference states that are no longer the ones that will actually be produced, since the
  // lock's spendCommitment was overwritten by prepare #2 before delegation.
  const checkStaleCall = await biVerifyOutputs(unlockCall1, sellerAddr, 70, buyerAddr);
  logger.log(`[info] checking the STALE (never-delegated) unlockCall1 against its own original terms: ${JSON.stringify(checkStaleCall)} -- not asserted, informational only (its outputs were never spent, so they may still resolve as unspent states; the REAL protection is that executing unlockCall1 itself would revert, proven next)`);

  // === Executing the STALE unlockCall1 (not the delegated one) must fail -- it doesn't match
  // the current spendCommitment (which reflects unlockCall2, set at delegation time). Paladin's
  // own public-tx submission does a static simulation before ever returning a txId, so this
  // reverts synchronously (throws) rather than producing a success:false receipt to poll. ===
  let staleExecOk = false;
  let staleExecDetail = "";
  try {
    const iface = new ethers.Interface(INotoJson.abi);
    const decoded = iface.decodeFunctionData("spendLock", unlockCall1);
    const txId = await bi.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: INotoJson.abi,
      function: "spendLock",
      from: biAtomStandIn.lookup,
      to: notoCash.address,
      data: { lockId: decoded[0], spendArgs: decoded[1], data: decoded[2] },
    });
    const staleExecReceipt = await bi.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT);
    staleExecOk = staleExecReceipt?.success === false;
    staleExecDetail = JSON.stringify({ success: staleExecReceipt?.success, failureMessage: staleExecReceipt?.failureMessage });
  } catch (e) {
    staleExecOk = true; // reverted synchronously at submission -- exactly the expected protection.
    staleExecDetail = `submission reverted synchronously: ${(e as Error).message}`;
  }
  check("executing the STALE (pre-delegation) unlockCall1 directly reverts -- does not match the frozen spendCommitment", staleExecOk, staleExecDetail);

  // === Positive end-to-end: executing the ACTUALLY delegated unlockCall2, from the delegate,
  // succeeds and produces exactly the outputs BI's check (against 40) already verified. ===
  const execReceipt = await bi.ptx
    .sendTransaction({
      type: TransactionType.PUBLIC,
      abi: INotoJson.abi,
      function: "spendLock",
      from: biAtomStandIn.lookup,
      to: notoCash.address,
      data: (() => {
        const iface = new ethers.Interface(INotoJson.abi);
        const decoded = iface.decodeFunctionData("spendLock", unlockCall2);
        return { lockId: decoded[0], spendArgs: decoded[1], data: decoded[2] };
      })(),
    })
    .then((txId) => bi.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT));
  check("executing the delegated unlockCall2 (as the delegate) succeeds", !!execReceipt?.success, JSON.stringify({ success: execReceipt?.success, failureMessage: execReceipt?.failureMessage }));

  console.log(failures === 0 ? "\nSUCCESS: #5b output-binding gap closed, verified live" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
