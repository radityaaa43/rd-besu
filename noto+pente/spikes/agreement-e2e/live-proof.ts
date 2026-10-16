/*
 * Task #8 / 0.3.0 mandatory live proof. Exercises paladin-client's Agreement.sol methods
 * end-to-end against the real cluster, in the lead-approved REORDERED flow (recordAtom runs
 * right after createAtom, BEFORE any leg delegates -- see
 * docs/superpowers/sdd/2026-10-05-outright-trade-contract.md's 2026-10-05 revision section).
 *
 * Scenario A: honest 2-party outright (bank1 sells asset1, bank2 pays with asset2) -> SETTLED.
 * Scenario B: a buyer-attack (bank2 re-prepares to worse terms before delegating) -- BI's
 *   verifyDelegatedLeg must reject it (ok=false) before executeAtom is ever called.
 * Scenario C: bank1 delegates, bank2 disappears (never delegates/recordLeg's done but no
 *   atom is ever executed) -- any party cancels the ATOM directly (not Agreement.cancel(),
 *   which is unreachable once ATOM_CREATED) and bank1's funds come back available.
 * Scenario D: releaseLock -- on an undelegated lock (succeeds, funds back available) and on a
 *   delegated one (throws PD_CLIENT_LOCK_DELEGATED, no transaction sent).
 *
 * Uses two plain basic-notary Noto tokens (BI is notary for both) -- Agreement.sol is
 * asset-agnostic, so the bond/cash hooks-mode machinery isn't needed for this proof.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node live-proof.ts
 */
import PaladinClient, { NotoFactory, PenteFactory, NotoInstance, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient } from "../../common/paladin-client/src/index";
import type { PaladinClient as PaladinClientWrapper } from "../../common/paladin-client/src/types";
import restrictedAtomFactoryArtifact from "../../common/paladin-client/src/abis/RestrictedAtomFactory.json";

const logger = console;
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(label: string, fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 40000): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (pred(last)) return last;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}, last value: ${JSON.stringify(last)}`);
}

// Prepared-output states aren't necessarily queryable on this node THE INSTANT delegateLock's
// receipt comes back -- same "a successful receipt doesn't mean peer nodes hold the resulting
// states" propagation lag the paladin-business-dev rules warn about generally, here applying
// to the PREPARING node's own state store catching up right after a delegate. Retry a few
// times rather than trusting the first call.
async function verifyWithRetry<T extends { ok: boolean }>(fn: () => Promise<T>, attempts = 8, delayMs = 1500): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.ok) return last;
    await sleep(delayMs);
  }
  return last!;
}

async function main(): Promise<boolean> {
  if (nodeConnections.length < 4) {
    logger.error("Need 4 nodes configured.");
    return false;
  }
  const runId = Date.now();
  const rawBi = new PaladinClient(nodeConnections[0].clientOptions);
  const rawBank1 = new PaladinClient(nodeConnections[1].clientOptions);
  const rawBank2 = new PaladinClient(nodeConnections[2].clientOptions);

  const biName = `biA${runId}`;
  const bank1Name = `bank1A${runId}`;
  const bank2Name = `bank2A${runId}`;
  const [biVerifier] = rawBi.getVerifiers(`${biName}@${nodeConnections[0].id}`);
  const [bank1Verifier] = rawBank1.getVerifiers(`${bank1Name}@${nodeConnections[1].id}`);
  const [bank2Verifier] = rawBank2.getVerifiers(`${bank2Name}@${nodeConnections[2].id}`);
  const biAddr = await biVerifier.address();
  const bank1Addr = await bank1Verifier.address();
  const bank2Addr = await bank2Verifier.address();
  logger.log(`biAddr=${biAddr} bank1Addr=${bank1Addr} bank2Addr=${bank2Addr}`);
  // prepareUnlock's recipients[].to is a LOOKUP (name@node) -- same as delegateLock's
  // delegateAddress... except AgreementLeg.from/to and createAtom's parties/executor, which
  // D2 (architecture review, 2026-10-05, BREAKING) changed from raw addresses to lookups too,
  // resolved internally. Mixing these up silently resolves to a different, unrelated identity
  // (found live writing this, pre-D2).
  const bank1Lookup = `${bank1Name}@${nodeConnections[1].id}`;
  const bank2Lookup = `${bank2Name}@${nodeConnections[2].id}`;
  const biLookup = `${biName}@${nodeConnections[0].id}`;

  logger.log("=== Deploying 2 scratch basic-notary Noto tokens (BI is notary for both) ===");
  const notoFactory = new NotoFactory(rawBi, "noto");
  const asset1 = await notoFactory.newNoto(biVerifier, { name: "AGE2EA", symbol: "AGA", notary: biVerifier, notaryMode: "basic" }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  const asset2 = await notoFactory.newNoto(biVerifier, { name: "AGE2EB", symbol: "AGB", notary: biVerifier, notaryMode: "basic" }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!asset1 || !asset2) return false;
  logger.log(`asset1(bond-like)=${asset1.address} asset2(cash-like)=${asset2.address}`);

  let r = await asset1.mint(biVerifier, { to: bank1Verifier, amount: "100000", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return false;
  r = await asset2.mint(biVerifier, { to: bank2Verifier, amount: "100000", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return false;

  // D1/lead fix (2026-10-05): RestrictedAtomFactory is deployed ONCE by the bootstrap, never
  // lazily by a client -- getOrDeployRestrictedAtomFactory is now a plain getter that requires
  // contractData.restrictedAtomFactoryAddress. Deploy it here with the raw SDK, standing in for
  // the bootstrap, and pass the address into biClient's config below.
  const factoryTxId = await rawBi.ptx.sendTransaction({
    type: TransactionType.PUBLIC,
    abi: restrictedAtomFactoryArtifact.abi,
    bytecode: restrictedAtomFactoryArtifact.bytecode.object,
    function: "",
    from: biVerifier.lookup,
    data: {},
  });
  const factoryReceipt = await rawBi.pollForReceipt(factoryTxId, DEFAULT_POLL_TIMEOUT);
  if (!factoryReceipt?.contractAddress) return false;
  const restrictedAtomFactoryAddress = factoryReceipt.contractAddress;
  logger.log(`restrictedAtomFactoryAddress=${restrictedAtomFactoryAddress}`);

  logger.log("=== Creating 3-party privacy group (bank1, bank2, BI) and deploying Agreement ===");
  const group = await new PenteFactory(rawBi, "pente")
    .newPrivacyGroup({ members: [bank1Verifier, bank2Verifier, biVerifier], evmVersion: "shanghai", externalCallsEnabled: false })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!group) return false;
  const groupId = group.group.id;

  const biClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    nodeId: nodeConnections[0].id,
    identity: biName,
    identities: { bondCustodian: `${biName}@${nodeConnections[0].id}` },
    contractData: { restrictedAtomFactoryAddress },
  });
  // releaseLock (scenario C/D) builds a self-release atom via createAtom too, so every
  // client -- not just BI's -- needs the same restrictedAtomFactoryAddress.
  const bank1Client: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[1].clientOptions.url!,
    nodeId: nodeConnections[1].id,
    identity: bank1Name,
    contractData: { restrictedAtomFactoryAddress },
  });
  const bank2Client: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[2].clientOptions.url!,
    nodeId: nodeConnections[2].id,
    identity: bank2Name,
    contractData: { restrictedAtomFactoryAddress },
  });

  const health = await biClient.health();
  check("health() returns a node name", !!health.nodeName, JSON.stringify(health));

  const { agreementAddress } = await biClient.deployAgreement(groupId);
  logger.log(`agreementAddress=${agreementAddress}`);
  await bank1Client.resumeAgreement(agreementAddress, groupId);
  await bank2Client.resumeAgreement(agreementAddress, groupId);

  const PRODUCT_TYPE = "outright";

  // =========================================================================================
  // Scenario A: honest outright -> SETTLED
  // =========================================================================================
  logger.log("\n=== Scenario A: honest 2-party outright ===");
  {
    const tradeId = `${asset1.address}:bank1:${runId}-A`;
    await bank1Client.proposeAgreement(groupId, agreementAddress, tradeId, PRODUCT_TYPE, [
      { asset: asset1.address, from: bank1Lookup, to: bank2Lookup, amount: "100" },
      { asset: asset2.address, from: bank2Lookup, to: bank1Lookup, amount: "50" },
    ]);
    await bank2Client.acceptAgreement(agreementAddress, tradeId);

    const { lockId: lockId0 } = await bank1Client.lockToken(asset1.address, "100");
    const leg0 = await bank1Client.prepareUnlock(asset1.address, lockId0, [{ to: bank2Lookup, amount: "100" }]);
    await bank1Client.recordLeg(agreementAddress, tradeId, 0, lockId0, leg0.preparedStateId, leg0.unlockCall, leg0.cancelCall);

    const { lockId: lockId1 } = await bank2Client.lockToken(asset2.address, "50");
    const leg1 = await bank2Client.prepareUnlock(asset2.address, lockId1, [{ to: bank1Lookup, amount: "50" }]);
    await bank2Client.recordLeg(agreementAddress, tradeId, 1, lockId1, leg1.preparedStateId, leg1.unlockCall, leg1.cancelCall);

    const afterLegs = await biClient.getAgreement(agreementAddress, tradeId);
    check("A: state is LEGS_PREPARED after both legs recorded", afterLegs.state === "LEGS_PREPARED", afterLegs.state);
    // Lead question (2026-10-05): is getAgreement() really the single source of truth for a
    // leg's cancelCall after recordLeg, round-tripped correctly on-chain? Confirmed live here.
    check("A: getAgreement round-trips leg0's cancelCall exactly", afterLegs.legs[0].cancelCall === leg0.cancelCall, `recorded=${leg0.cancelCall.slice(0, 20)}... readBack=${afterLegs.legs[0].cancelCall?.slice(0, 20)}...`);
    check("A: getAgreement round-trips leg1's cancelCall exactly", afterLegs.legs[1].cancelCall === leg1.cancelCall, `recorded=${leg1.cancelCall.slice(0, 20)}... readBack=${afterLegs.legs[1].cancelCall?.slice(0, 20)}...`);

    const cc0 = await biClient.verifyCancelCall(asset1.address, lockId0, leg0.cancelCall, bank1Addr);
    const cc1 = await biClient.verifyCancelCall(asset2.address, lockId1, leg1.cancelCall, bank2Addr);
    check("A: verifyCancelCall leg0 ok (pre-delegation, lead-decided reorder)", cc0.ok, JSON.stringify(cc0));
    check("A: verifyCancelCall leg1 ok (pre-delegation, lead-decided reorder)", cc1.ok, JSON.stringify(cc1));

    const { atomAddress } = await biClient.createAtom(
      [
        { contractAddress: asset1.address, callData: leg0.unlockCall },
        { contractAddress: asset2.address, callData: leg1.unlockCall },
      ],
      [
        { contractAddress: asset1.address, lockId: lockId0, callData: leg0.cancelCall },
        { contractAddress: asset2.address, lockId: lockId1, callData: leg1.cancelCall },
      ],
      [bank1Lookup, bank2Lookup],
      biLookup
    );
    logger.log(`A: atomAddress=${atomAddress}`);

    // Reorder: recordAtom BEFORE any delegation.
    await biClient.recordAtom(agreementAddress, tradeId, atomAddress);
    const afterRecordAtom = await biClient.getAgreement(agreementAddress, tradeId);
    check("A: state is ATOM_CREATED before any delegation", afterRecordAtom.state === "ATOM_CREATED", afterRecordAtom.state);

    await bank1Client.delegateLock(asset1.address, lockId0, atomAddress);
    await bank2Client.delegateLock(asset2.address, lockId1, atomAddress);

    const vd0 = await verifyWithRetry(() => biClient.verifyDelegatedLeg(asset1.address, lockId0, leg0.unlockCall, { recipient: bank2Addr, amount: "100", owner: bank1Addr }, atomAddress));
    const vd1 = await verifyWithRetry(() => biClient.verifyDelegatedLeg(asset2.address, lockId1, leg1.unlockCall, { recipient: bank1Addr, amount: "50", owner: bank2Addr }, atomAddress));
    check("A: verifyDelegatedLeg leg0 ok after delegation", vd0.ok, JSON.stringify(vd0));
    check("A: verifyDelegatedLeg leg1 ok after delegation", vd1.ok, JSON.stringify(vd1));
    if (!vd0.ok || !vd1.ok) {
      logger.error("A: aborting before executeAtom since verification did not pass");
      return false;
    }

    await biClient.executeAtom(atomAddress);
    await biClient.confirmSettled(agreementAddress, tradeId);

    const final = await biClient.getAgreement(agreementAddress, tradeId);
    check("A: state is SETTLED", final.state === "SETTLED", final.state);

    const bank1Asset1 = await waitFor("bank1 asset1 balance drop", () => bank1Client.balances(asset1.address), (b) => b.available === "99900");
    const bank2Asset1 = await waitFor("bank2 asset1 balance rise", () => bank2Client.balances(asset1.address), (b) => b.available === "100");
    const bank2Asset2 = await waitFor("bank2 asset2 balance drop", () => bank2Client.balances(asset2.address), (b) => b.available === "99950");
    const bank1Asset2 = await waitFor("bank1 asset2 balance rise", () => bank1Client.balances(asset2.address), (b) => b.available === "50");
    check("A: bank1 asset1 available == 99900", bank1Asset1.available === "99900", bank1Asset1.available);
    check("A: bank2 asset1 available == 100", bank2Asset1.available === "100", bank2Asset1.available);
    check("A: bank2 asset2 available == 99950", bank2Asset2.available === "99950", bank2Asset2.available);
    check("A: bank1 asset2 available == 50", bank1Asset2.available === "50", bank1Asset2.available);
  }

  // =========================================================================================
  // Scenario B: buyer attack -- bank2 re-prepares to worse terms before delegating.
  // verifyDelegatedLeg must reject the actually-delegated (bad) unlockCall; BI never executes.
  // =========================================================================================
  logger.log("\n=== Scenario B: buyer-attack rejection ===");
  {
    const tradeId = `${asset1.address}:bank1:${runId}-B`;
    await bank1Client.proposeAgreement(groupId, agreementAddress, tradeId, PRODUCT_TYPE, [
      { asset: asset1.address, from: bank1Lookup, to: bank2Lookup, amount: "100" },
      { asset: asset2.address, from: bank2Lookup, to: bank1Lookup, amount: "50" },
    ]);
    await bank2Client.acceptAgreement(agreementAddress, tradeId);

    const { lockId: lockId0 } = await bank1Client.lockToken(asset1.address, "100");
    const leg0 = await bank1Client.prepareUnlock(asset1.address, lockId0, [{ to: bank2Lookup, amount: "100" }]);
    await bank1Client.recordLeg(agreementAddress, tradeId, 0, lockId0, leg0.preparedStateId, leg0.unlockCall, leg0.cancelCall);

    const { lockId: lockId1 } = await bank2Client.lockToken(asset2.address, "50");
    const honestLeg1 = await bank2Client.prepareUnlock(asset2.address, lockId1, [{ to: bank1Lookup, amount: "50" }]);
    await bank2Client.recordLeg(agreementAddress, tradeId, 1, lockId1, honestLeg1.preparedStateId, honestLeg1.unlockCall, honestLeg1.cancelCall);

    // Attack: bank2 (buyer) re-prepares the SAME lock to a worse deal -- only 10 to bank1, 40
    // back to itself -- using the explicit opt-out, since the lock is still pre-delegation.
    const attackLeg1 = await bank2Client.prepareUnlock(asset2.address, lockId1, [{ to: bank1Lookup, amount: "10" }, { to: bank2Lookup, amount: "40" }], undefined, {
      allowRePrepare: true,
    });
    check("B: buyer's re-prepare-to-worse-terms succeeds on-chain (lock still mutable pre-delegation)", !!attackLeg1.unlockCall, "re-prepared");

    const { atomAddress } = await biClient.createAtom(
      [
        { contractAddress: asset1.address, callData: leg0.unlockCall },
        { contractAddress: asset2.address, callData: attackLeg1.unlockCall }, // BI unwittingly builds the atom from the bad unlockCall actually delegated
      ],
      [
        { contractAddress: asset1.address, lockId: lockId0, callData: leg0.cancelCall },
        { contractAddress: asset2.address, lockId: lockId1, callData: attackLeg1.cancelCall },
      ],
      [bank1Lookup, bank2Lookup],
      biLookup
    );
    await biClient.recordAtom(agreementAddress, tradeId, atomAddress);

    await bank1Client.delegateLock(asset1.address, lockId0, atomAddress);
    await bank2Client.delegateLock(asset2.address, lockId1, atomAddress);

    // BI verifies against what's ACTUALLY delegated (attackLeg1.unlockCall) vs the ORIGINALLY
    // AGREED terms (50 to bank1) -- this must fail.
    const vdAttack = await verifyWithRetry(() => biClient.verifyDelegatedLeg(asset2.address, lockId1, attackLeg1.unlockCall, { recipient: bank1Addr, amount: "50", owner: bank2Addr }, atomAddress));
    check("B: verifyDelegatedLeg REJECTS the attack (wrong amount)", vdAttack.ok === false, JSON.stringify(vdAttack));

    if (vdAttack.ok) {
      logger.error("B: SAFETY VIOLATION -- attack was not rejected, aborting before executeAtom to avoid an unintended real settlement");
      return false;
    }
    logger.log("B: BI correctly aborts -- executeAtom is never called. Recovering via atom.cancel() + markFailed, same as scenario C.");
    await biClient.cancelAtom(atomAddress);
    await biClient.markFailed(agreementAddress, tradeId);
    const final = await biClient.getAgreement(agreementAddress, tradeId);
    check("B: state is FAILED after recovery", final.state === "FAILED", final.state);

    const bank1Asset1Back = await waitFor("B: bank1 asset1 back to 99900 after abort+recover", () => bank1Client.balances(asset1.address), (b) => b.available === "99900");
    check("B: bank1's asset1 leg recovered (available back to pre-trade 99900)", bank1Asset1Back.available === "99900", bank1Asset1Back.available);
  }

  // =========================================================================================
  // Scenario C: bank1 delegates, bank2 disappears -- any party cancels the ATOM directly
  // (Agreement.cancel() is unreachable once ATOM_CREATED by the reorder) -- bank1's funds
  // come back available.
  // =========================================================================================
  logger.log("\n=== Scenario C: delegate-then-abandon-then-recover ===");
  {
    const tradeId = `${asset1.address}:bank1:${runId}-C`;
    await bank1Client.proposeAgreement(groupId, agreementAddress, tradeId, PRODUCT_TYPE, [
      { asset: asset1.address, from: bank1Lookup, to: bank2Lookup, amount: "200" },
      { asset: asset2.address, from: bank2Lookup, to: bank1Lookup, amount: "75" },
    ]);
    await bank2Client.acceptAgreement(agreementAddress, tradeId);

    // Snapshot BEFORE locking anything -- the correct "should come all the way back to this"
    // baseline for the restored-availability check after abandon+recover below.
    const beforeAnything = await bank1Client.balances(asset1.address);
    logger.log(`C: bank1 asset1 available before locking leg0: ${beforeAnything.available}`);

    const { lockId: lockId0 } = await bank1Client.lockToken(asset1.address, "200");
    const leg0 = await bank1Client.prepareUnlock(asset1.address, lockId0, [{ to: bank2Lookup, amount: "200" }]);
    await bank1Client.recordLeg(agreementAddress, tradeId, 0, lockId0, leg0.preparedStateId, leg0.unlockCall, leg0.cancelCall);

    const { lockId: lockId1 } = await bank2Client.lockToken(asset2.address, "75");
    const leg1 = await bank2Client.prepareUnlock(asset2.address, lockId1, [{ to: bank1Lookup, amount: "75" }]);
    await bank2Client.recordLeg(agreementAddress, tradeId, 1, lockId1, leg1.preparedStateId, leg1.unlockCall, leg1.cancelCall);

    const { atomAddress } = await biClient.createAtom(
      [
        { contractAddress: asset1.address, callData: leg0.unlockCall },
        { contractAddress: asset2.address, callData: leg1.unlockCall },
      ],
      [
        { contractAddress: asset1.address, lockId: lockId0, callData: leg0.cancelCall },
        { contractAddress: asset2.address, lockId: lockId1, callData: leg1.cancelCall },
      ],
      [bank1Lookup, bank2Lookup],
      biLookup
    );
    await biClient.recordAtom(agreementAddress, tradeId, atomAddress);

    // bank1 delegates; bank2 "disappears" (never delegates leg1, never responds again).
    await bank1Client.delegateLock(asset1.address, lockId0, atomAddress);

    // Confirm Agreement.cancel() is unreachable now (lead-decided reorder closes this window).
    let agreementCancelRejected = false;
    try {
      await bank1Client.cancelAgreement(agreementAddress, tradeId);
    } catch {
      agreementCancelRejected = true;
    }
    check("C: cancelAgreement is unreachable once ATOM_CREATED (reorder invariant)", agreementCancelRejected, String(agreementCancelRejected));

    // Recovery: cancel the ATOM directly (any party), which releases bank1's delegated leg.
    await biClient.cancelAtom(atomAddress);
    await biClient.markFailed(agreementAddress, tradeId);
    const final = await biClient.getAgreement(agreementAddress, tradeId);
    check("C: state is FAILED after recovery", final.state === "FAILED", final.state);

    const bank1Asset1Back = await waitFor("C: bank1 asset1 available restored", () => bank1Client.balances(asset1.address), (b) => b.available === beforeAnything.available);
    check("C: bank1's delegated leg0 released back to available", bank1Asset1Back.available === beforeAnything.available, bank1Asset1Back.available);

    // bank2 never delegated leg1 at all -- releaseLock (scenario D below) covers that path.
    await bank2Client.releaseLock(asset2.address, lockId1);
    const bank2Asset2Back = await waitFor("C: bank2 asset2 available restored via releaseLock", () => bank2Client.balances(asset2.address), (b) => Number(b.available) >= 99950);
    check("C: bank2's never-delegated leg1 released via releaseLock", Number(bank2Asset2Back.available) >= 99950, bank2Asset2Back.available);
  }

  // =========================================================================================
  // Scenario D: releaseLock -- undelegated succeeds; delegated throws, no tx sent.
  // =========================================================================================
  logger.log("\n=== Scenario D: releaseLock behavior ===");
  {
    const before = await bank1Client.balances(asset1.address);
    const { lockId } = await bank1Client.lockToken(asset1.address, "25");
    const midLock = await bank1Client.balances(asset1.address);
    check("D: locking reduces available, increases locked", Number(midLock.available) === Number(before.available) - 25, JSON.stringify(midLock));

    await bank1Client.releaseLock(asset1.address, lockId);
    const afterRelease = await waitFor("D: available restored after releaseLock", () => bank1Client.balances(asset1.address), (b) => b.available === before.available);
    check("D: releaseLock on an UNDELEGATED lock restores available", afterRelease.available === before.available, afterRelease.available);

    // Now delegate a fresh lock and confirm releaseLock refuses it, with NO tx sent.
    const { lockId: lockId2 } = await bank1Client.lockToken(asset1.address, "25");
    const prep = await bank1Client.prepareUnlock(asset1.address, lockId2, [{ to: bank2Lookup, amount: "25" }]);
    const { atomAddress: standInAtom } = await biClient.createAtom([{ contractAddress: asset1.address, callData: prep.unlockCall }], [], [bank1Lookup], biLookup);
    await bank1Client.delegateLock(asset1.address, lockId2, standInAtom);

    let threwDelegated = false;
    let code: string | undefined;
    try {
      await bank1Client.releaseLock(asset1.address, lockId2);
    } catch (e) {
      threwDelegated = true;
      code = (e as { code?: string }).code;
    }
    check("D: releaseLock on a DELEGATED lock throws PD_CLIENT_LOCK_DELEGATED", threwDelegated && code === "PD_CLIENT_LOCK_DELEGATED", `threw=${threwDelegated} code=${code}`);

    // Clean up this standalone atom so the lock isn't left dangling.
    await biClient.executeAtom(standInAtom);
  }

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
