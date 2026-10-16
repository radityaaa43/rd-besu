/*
 * 0.4.0 mandatory live proof, part 2 (part 1: ../agreement-e2e/live-proof.ts covers outright
 * B/C/D). Exercises the primary-subscription path (D1: the SAME Agreement+RestrictedAtom
 * primitives as outright, productType="PRIMARY") against a REAL hooked bond token
 * (BondTracker/InvestorList), plus the scenarios outright doesn't touch:
 *
 * Scenario A: issueSeries -> getSeries round-trip, registry write signed by bondCustodian (D3/D4).
 * Scenario B: ensureInvestorCustodianGroup -- BI creates, investor (node2) independently finds
 *   the SAME groupId (the backend's group-discovery addition).
 * Scenario C: primary subscription through Agreement+RestrictedAtom, using delegateTradeLeg
 *   (D6) for both legs -> SETTLED. Confirms BondTracker's whitelist hook (onPrepareUnlock's
 *   _checkTransfers) actually ran for the bond leg -- an unwhitelisted investor would have
 *   reverted at prepareUnlock, never gotten this far.
 * Scenario D: onAtomStatusChanged (D5) receives Executed (from C's atom) and Cancelled (from a
 *   separate standalone atom built and cancelled here).
 * Scenario E: delegateTradeLeg (D6) refuses to delegate when a bogus atom's on-chain operations
 *   don't match the leg's recorded unlockCall.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node live-proof.ts
 */
import PaladinClient, { NotoFactory, PenteFactory, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient } from "../../common/paladin-client/src/index";
import type { PaladinClient as PaladinClientWrapper } from "../../common/paladin-client/src/types";
import restrictedAtomFactoryArtifact from "../../common/paladin-client/src/abis/RestrictedAtomFactory.json";
import bondSeriesRegistryArtifact from "../../common/paladin-client/src/abis/BondSeriesRegistry.json";
import restrictedAtomArtifact from "../../common/paladin-client/src/abis/RestrictedAtom.json";

const logger = console;
let failures = 0;
const check = (label: string, ok: boolean, detail: unknown) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
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
  if (nodeConnections.length < 2) {
    logger.error("Need at least 2 nodes configured.");
    return false;
  }
  const runId = Date.now();
  const rawNode1 = new PaladinClient(nodeConnections[0].clientOptions);
  const rawNode2 = new PaladinClient(nodeConnections[1].clientOptions);

  const issuerName = `bondIssuerP${runId}`;
  const custodianName = `bondCustodianP${runId}`;
  const investorName = `investorP${runId}`;
  const [issuerVerifier] = rawNode1.getVerifiers(`${issuerName}@${nodeConnections[0].id}`);
  const [custodianVerifier] = rawNode1.getVerifiers(`${custodianName}@${nodeConnections[0].id}`);
  const [investorVerifier] = rawNode2.getVerifiers(`${investorName}@${nodeConnections[1].id}`);
  const issuerAddr = await issuerVerifier.address();
  const custodianAddr = await custodianVerifier.address();
  const investorAddr = await investorVerifier.address();
  const issuerLookup = issuerVerifier.lookup;
  const custodianLookup = custodianVerifier.lookup;
  const investorLookup = investorVerifier.lookup;
  logger.log(`issuerAddr=${issuerAddr} custodianAddr=${custodianAddr} investorAddr=${investorAddr}`);

  logger.log("=== Setup: BondSeriesRegistry(owner=bondCustodian) + RestrictedAtomFactory + scratch cash Noto ===");
  const registryReceipt = await rawNode1.pollForReceipt(
    await rawNode1.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: bondSeriesRegistryArtifact.abi,
      bytecode: bondSeriesRegistryArtifact.bytecode.object,
      function: "",
      from: custodianLookup,
      data: { owner_: custodianAddr },
    }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!registryReceipt?.contractAddress) return false;
  const registryAddress = registryReceipt.contractAddress;
  logger.log(`registryAddress=${registryAddress}`);

  const factoryReceipt = await rawNode1.pollForReceipt(
    await rawNode1.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: restrictedAtomFactoryArtifact.abi,
      bytecode: restrictedAtomFactoryArtifact.bytecode.object,
      function: "",
      from: issuerLookup,
      data: {},
    }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!factoryReceipt?.contractAddress) return false;
  const restrictedAtomFactoryAddress = factoryReceipt.contractAddress;
  logger.log(`restrictedAtomFactoryAddress=${restrictedAtomFactoryAddress}`);

  const cashNoto = await new NotoFactory(rawNode1, "noto")
    .newNoto(custodianVerifier, { name: "PRIMCASH", symbol: "PCASH", notary: custodianVerifier, notaryMode: "basic" })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashNoto) return false;
  const cashToken = cashNoto.address;
  let r = await cashNoto.mint(custodianVerifier, { to: investorVerifier, amount: "100000", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return false;
  logger.log(`cashToken=${cashToken}, minted 100000 to investor`);

  // --- paladin-client instances: issuer and custodian are SEPARATE identities on node1
  // (BondTracker.onMint is onlyIssuer -- gated on whoever deployed it, i.e. the signer
  // issueSeries uses for the deploy step; deployAgreement/recordAtom/confirmSettled are
  // onlyBI == bondCustodian). Both resolvable from either client since they share a node.
  const issuerClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    nodeId: nodeConnections[0].id,
    identity: issuerName,
    identities: { registryAddress, bondIssuer: issuerLookup, bondCustodian: custodianLookup },
    contractData: { restrictedAtomFactoryAddress },
  });
  const custodianClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    // Port-forward convention: WS is a SEPARATE port, HTTP port + 1 (PaladinClientConfig's own
    // doc comment) -- custodianClient needs this for onAtomStatusChanged (Scenario D).
    wsUrl: nodeConnections[0].clientOptions.url!.replace(/^http/, "ws").replace(/(\d+)$/, (p) => String(Number(p) + 1)),
    nodeId: nodeConnections[0].id,
    identity: custodianName,
    identities: { registryAddress, bondIssuer: issuerLookup, bondCustodian: custodianLookup },
    contractData: { restrictedAtomFactoryAddress },
  });
  const investorClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[1].clientOptions.url!,
    nodeId: nodeConnections[1].id,
    identity: investorName,
    identities: { bondCustodian: custodianLookup },
    contractData: { restrictedAtomFactoryAddress },
  });

  // =========================================================================================
  // Scenario A: issueSeries -> getSeries round-trip (D3 encoding, D4 signer)
  // =========================================================================================
  logger.log("\n=== Scenario A: issueSeries + getSeries round-trip ===");
  const seriesParams = {
    instrumentType: "SUKUK",
    seriesCode: `S${runId}`,
    isin: "ID1000012345",
    currencyToken: cashToken,
    faceValue: "1000000",
    issueDate: "2026-10-06T00:00:00.000Z",
    maturityDate: "2030-10-06T00:00:00.000Z",
    transferRestricted: true,
    termsHash: "0x" + "ab".repeat(32),
  };
  const { token: bondToken, privateTracker, groupId: issuerCustodianGroupId } = await issuerClient.issueSeries(seriesParams);
  logger.log(`bondToken=${bondToken} privateTracker=${privateTracker} issuerCustodianGroupId=${issuerCustodianGroupId}`);

  const series = await custodianClient.getSeries(bondToken);
  check("A: getSeries round-trips instrumentType", series.instrumentType === seriesParams.instrumentType, series.instrumentType);
  check("A: getSeries round-trips seriesCode", series.seriesCode === seriesParams.seriesCode, series.seriesCode);
  check("A: getSeries round-trips isin", series.isin === seriesParams.isin, series.isin);
  check("A: getSeries round-trips issueDate", series.issueDate === seriesParams.issueDate, series.issueDate);
  check("A: getSeries round-trips maturityDate", series.maturityDate === seriesParams.maturityDate, series.maturityDate);
  check("A: getSeries round-trips termsHash", series.termsHash?.toLowerCase() === seriesParams.termsHash.toLowerCase(), series.termsHash);
  check("A: getSeries round-trips transferRestricted", series.transferRestricted === seriesParams.transferRestricted, series.transferRestricted);

  // Whitelist investor + mint bond supply to custodian (issuer signs the mint -- onlyIssuer).
  await issuerClient.addInvestor(bondToken, investorLookup);
  await issuerClient.mintToken(bondToken, custodianLookup, "1000");
  const custodianBondBefore = await waitFor("custodian bond balance after mint", () => custodianClient.balances(bondToken), (b) => b.available === "1000");
  check("A: custodian holds 1000 bond units after mint", custodianBondBefore.available === "1000", custodianBondBefore.available);

  return await mainPart2({
    issuerClient,
    custodianClient,
    investorClient,
    custodianLookup,
    investorLookup,
    custodianAddr,
    investorAddr,
    bondToken,
    cashToken,
    restrictedAtomFactoryAddress,
  });
}

async function mainPart2(ctx: {
  issuerClient: PaladinClientWrapper;
  custodianClient: PaladinClientWrapper;
  investorClient: PaladinClientWrapper;
  custodianLookup: string;
  investorLookup: string;
  custodianAddr: string;
  investorAddr: string;
  bondToken: string;
  cashToken: string;
  restrictedAtomFactoryAddress: string;
}): Promise<boolean> {
  const { custodianClient, investorClient, custodianLookup, investorLookup, custodianAddr, investorAddr, bondToken, cashToken } = ctx;
  const runId = Date.now();

  // Real scenario B: BI's client has no way to "ensure a group for an arbitrary investor" via
  // ensurePrimaryGroup (that method is for the CALLER's own relationship) -- the actual
  // cross-party discovery contract is findGroupsWithMembers/ensureInvestorCustodianGroup,
  // which both sides call with the SAME investorLookup.
  const biGroup = await custodianClient.ensureInvestorCustodianGroup(investorLookup);
  const investorGroup = await investorClient.ensureInvestorCustodianGroup(investorLookup);
  check("B: BI creates the investor+custodian group", !!biGroup.groupId, biGroup);
  check("B: investor (node2) independently finds the SAME groupId", investorGroup.groupId === biGroup.groupId, { bi: biGroup.groupId, investor: investorGroup.groupId });
  const groupId = biGroup.groupId;

  // =========================================================================================
  // Scenario C: primary subscription through Agreement+RestrictedAtom, via delegateTradeLeg -> SETTLED
  // =========================================================================================
  logger.log("\n=== Scenario C: primary subscription -> SETTLED ===");
  const { agreementAddress } = await custodianClient.deployAgreement(groupId);
  logger.log(`agreementAddress=${agreementAddress}`);
  await investorClient.resumeAgreement(agreementAddress, groupId);

  const tradeId = `${bondToken}:primary:${runId}-C`;
  await custodianClient.proposeAgreement(groupId, agreementAddress, tradeId, "PRIMARY", [
    { asset: bondToken, from: custodianLookup, to: investorLookup, amount: "100" },
    { asset: cashToken, from: investorLookup, to: custodianLookup, amount: "50" },
  ]);
  await investorClient.acceptAgreement(agreementAddress, tradeId);

  const { lockId: bondLockId } = await custodianClient.lockToken(bondToken, "100");
  const bondLeg = await custodianClient.prepareUnlock(bondToken, bondLockId, [{ to: investorLookup, amount: "100" }]);
  await custodianClient.recordLeg(agreementAddress, tradeId, 0, bondLockId, bondLeg.preparedStateId, bondLeg.unlockCall, bondLeg.cancelCall);

  const { lockId: cashLockId } = await investorClient.lockToken(cashToken, "50");
  const cashLeg = await investorClient.prepareUnlock(cashToken, cashLockId, [{ to: custodianLookup, amount: "50" }]);
  await investorClient.recordLeg(agreementAddress, tradeId, 1, cashLockId, cashLeg.preparedStateId, cashLeg.unlockCall, cashLeg.cancelCall);

  const afterLegs = await custodianClient.getAgreement(agreementAddress, tradeId);
  check("C: state is LEGS_PREPARED after both legs recorded", afterLegs.state === "LEGS_PREPARED", afterLegs.state);

  const ccBond = await custodianClient.verifyCancelCall(bondToken, bondLockId, bondLeg.cancelCall, custodianAddr);
  const ccCash = await custodianClient.verifyCancelCall(cashToken, cashLockId, cashLeg.cancelCall, investorAddr);
  check("C: verifyCancelCall bond leg ok", ccBond.ok, ccBond);
  check("C: verifyCancelCall cash leg ok", ccCash.ok, ccCash);

  const { atomAddress } = await custodianClient.createAtom(
    [
      { contractAddress: bondToken, callData: bondLeg.unlockCall },
      { contractAddress: cashToken, callData: cashLeg.unlockCall },
    ],
    [
      { contractAddress: bondToken, lockId: bondLockId, callData: bondLeg.cancelCall },
      { contractAddress: cashToken, lockId: cashLockId, callData: cashLeg.cancelCall },
    ],
    [custodianLookup, investorLookup],
    custodianLookup
  );
  logger.log(`C: atomAddress=${atomAddress}`);
  await custodianClient.recordAtom(agreementAddress, tradeId, atomAddress);

  // =========================================================================================
  // Scenario D: onAtomStatusChanged (D5) -- register the listener BEFORE executeAtom so it
  // catches this atom's Executed event; Cancelled is covered by a separate standalone atom below.
  // =========================================================================================
  logger.log("\n=== Scenario D: onAtomStatusChanged ===");
  const seenEvents: { atomAddress: string; status: string }[] = [];
  await custodianClient.onAtomStatusChanged(
    `atom-status-${runId}`,
    async (event) => {
      seenEvents.push({ atomAddress: event.atomAddress.toLowerCase(), status: event.status });
    },
    { startFromLatest: true }
  );

  // D6: delegateTradeLeg verifies the atom's real on-chain operations/cancelOperations/executor
  // against each leg's recorded unlockCall/cancelCall before ever calling delegateLock.
  await custodianClient.delegateTradeLeg(agreementAddress, tradeId, 0);
  await investorClient.delegateTradeLeg(agreementAddress, tradeId, 1);

  const vdBond = await verifyWithRetry(() => custodianClient.verifyDelegatedLeg(bondToken, bondLockId, bondLeg.unlockCall, { recipient: investorAddr, amount: "100", owner: custodianAddr }, atomAddress));
  const vdCash = await verifyWithRetry(() => custodianClient.verifyDelegatedLeg(cashToken, cashLockId, cashLeg.unlockCall, { recipient: custodianAddr, amount: "50", owner: investorAddr }, atomAddress));
  check("C: verifyDelegatedLeg bond leg ok after delegation", vdBond.ok, vdBond);
  check("C: verifyDelegatedLeg cash leg ok after delegation", vdCash.ok, vdCash);
  if (!vdBond.ok || !vdCash.ok) {
    logger.error("C: aborting before executeAtom since verification did not pass");
    return false;
  }

  await custodianClient.executeAtom(atomAddress);
  await custodianClient.confirmSettled(agreementAddress, tradeId);
  const final = await custodianClient.getAgreement(agreementAddress, tradeId);
  check("C: state is SETTLED", final.state === "SETTLED", final.state);

  // The whitelist hook (BondTracker.onPrepareUnlock -> _checkTransfers -> InvestorList.
  // checkTransfer) ran during prepareUnlock above -- if investor hadn't been whitelisted
  // (Scenario A's addInvestor), that call would have reverted and we'd never have reached here.
  const investorBond = await waitFor("investor bond balance after settlement", () => investorClient.balances(bondToken), (b) => b.available === "100");
  const custodianCash = await waitFor("custodian cash balance after settlement", () => custodianClient.balances(cashToken), (b) => b.available === "50");
  check("C: investor received 100 bond units (BondTracker whitelist hook allowed it)", investorBond.available === "100", investorBond.available);
  check("C: custodian received 50 cash", custodianCash.available === "50", custodianCash.available);

  // Cancelled half of Scenario D: a standalone throwaway atom, cancelled directly.
  const { lockId: standInLockId } = await custodianClient.lockToken(bondToken, "10");
  const standInLeg = await custodianClient.prepareUnlock(bondToken, standInLockId, [{ to: investorLookup, amount: "10" }]);
  const { atomAddress: standInAtom } = await custodianClient.createAtom([{ contractAddress: bondToken, callData: standInLeg.unlockCall }], [], [custodianLookup], custodianLookup);
  await custodianClient.delegateLock(bondToken, standInLockId, standInAtom);
  await custodianClient.cancelAtom(standInAtom);

  const gotExecuted = await waitFor("onAtomStatusChanged received Executed", async () => seenEvents, (evs) => evs.some((e) => e.atomAddress === atomAddress.toLowerCase() && e.status === "Executed")).catch((e) => {
    logger.error(String(e));
    return seenEvents;
  });
  const gotCancelled = await waitFor("onAtomStatusChanged received Cancelled", async () => seenEvents, (evs) => evs.some((e) => e.atomAddress === standInAtom.toLowerCase() && e.status === "Cancelled")).catch((e) => {
    logger.error(String(e));
    return seenEvents;
  });
  check("D: onAtomStatusChanged received Executed for the primary-subscription atom", gotExecuted.some((e) => e.atomAddress === atomAddress.toLowerCase() && e.status === "Executed"), gotExecuted);
  check("D: onAtomStatusChanged received Cancelled for the standalone atom", gotCancelled.some((e) => e.atomAddress === standInAtom.toLowerCase() && e.status === "Cancelled"), gotCancelled);

  // =========================================================================================
  // Scenario E: delegateTradeLeg refuses when a bogus atom's operations don't match the leg.
  // =========================================================================================
  logger.log("\n=== Scenario E: delegateTradeLeg refuses a mismatched atom ===");
  const tradeId2 = `${bondToken}:primary:${runId}-E`;
  await custodianClient.proposeAgreement(groupId, agreementAddress, tradeId2, "PRIMARY", [
    { asset: bondToken, from: custodianLookup, to: investorLookup, amount: "20" },
    { asset: cashToken, from: investorLookup, to: custodianLookup, amount: "10" },
  ]);
  await investorClient.acceptAgreement(agreementAddress, tradeId2);

  const { lockId: bondLockId2 } = await custodianClient.lockToken(bondToken, "20");
  const bondLeg2 = await custodianClient.prepareUnlock(bondToken, bondLockId2, [{ to: investorLookup, amount: "20" }]);
  await custodianClient.recordLeg(agreementAddress, tradeId2, 0, bondLockId2, bondLeg2.preparedStateId, bondLeg2.unlockCall, bondLeg2.cancelCall);

  const { lockId: cashLockId2 } = await investorClient.lockToken(cashToken, "10");
  const cashLeg2 = await investorClient.prepareUnlock(cashToken, cashLockId2, [{ to: custodianLookup, amount: "10" }]);
  await investorClient.recordLeg(agreementAddress, tradeId2, 1, cashLockId2, cashLeg2.preparedStateId, cashLeg2.unlockCall, cashLeg2.cancelCall);

  // Build a BOGUS atom whose bond-leg operation's callData does NOT match what was recorded
  // for leg 0 (swap in a throwaway unlockCall from a totally different, unrelated lock).
  const { lockId: decoyLockId } = await custodianClient.lockToken(bondToken, "5");
  const decoyLeg = await custodianClient.prepareUnlock(bondToken, decoyLockId, [{ to: investorLookup, amount: "5" }]);
  const { atomAddress: bogusAtom } = await custodianClient.createAtom(
    [
      { contractAddress: bondToken, callData: decoyLeg.unlockCall }, // mismatched -- not bondLeg2.unlockCall
      { contractAddress: cashToken, callData: cashLeg2.unlockCall },
    ],
    [
      { contractAddress: bondToken, lockId: decoyLockId, callData: decoyLeg.cancelCall },
      { contractAddress: cashToken, lockId: cashLockId2, callData: cashLeg2.cancelCall },
    ],
    [custodianLookup, investorLookup],
    custodianLookup
  );
  await custodianClient.recordAtom(agreementAddress, tradeId2, bogusAtom);

  let refused = false;
  let refusalCode: string | undefined;
  try {
    await custodianClient.delegateTradeLeg(agreementAddress, tradeId2, 0);
  } catch (e) {
    refused = true;
    refusalCode = (e as { code?: string }).code;
  }
  check("E: delegateTradeLeg refuses when the atom's operations don't match the recorded leg", refused && refusalCode === "PD_CLIENT_ATOM_MISMATCH", `refused=${refused} code=${refusalCode}`);

  // Clean up: cancel the bogus atom. The decoy/bondLockId2 bond-leg locks are left dangling
  // deliberately -- releaseLock always releases back to the caller (custodian here), and
  // custodian was never added to the bond's own InvestorList (it's the issuer-side holder, not
  // an investor); unlocking them would need custodian whitelisted too, which is out of scope
  // for this test. Harmless: this is a throwaway scratch bond token for this run only.
  await custodianClient.cancelAtom(bogusAtom);
  await investorClient.releaseLock(cashToken, cashLockId2);

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
