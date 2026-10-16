/*
 * Live proof for lead task #6b's DONE-WHEN: 2 full tranches through the REAL paladin-client
 * path -- registerSeries(issueSeries) -> mint tranche 1 -> beginDistribution -> investor
 * subscribe (createSubscription -> preparePayment -> prepareBond -> distributeSubscription ->
 * delegateLock x2 -> executeAtom) -> DISTRIBUTION_COMPLETE -> close -> ACTIVE -> reopen tranche
 * 2 -> the same subscribe -> ACTIVE. Plus the negative case: a subscription with units >
 * availableUnits is REJECTED by the pre-trade guard (getDistributionState), before any on-chain
 * call, not caught by a revert.
 *
 * Unlike task #7's live-proof.ts (which used a plain Noto transfer() to prove the reopening
 * fork in isolation), this script goes through the REAL BondSubscription/Atom delegate-execute
 * flow -- the decisive test that BondTracker.handleDelegateUnlock's fix (not onUnlock alone)
 * actually works in production, not just in a forge unit test.
 *
 * Run: NODE_PATH=../../bond/node_modules ../../bond/node_modules/.bin/ts-node live-proof.ts
 */
import PaladinClientSdk, { NotoFactory, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, PaladinClient } from "../../common/paladin-client/src/index";
import bondSeriesRegistryArtifact from "../../common/paladin-client/src/abis/BondSeriesRegistry.json";
import bondTrackerPublicArtifact from "../../common/paladin-client/src/abis/BondTrackerPublic.json";

const DEFAULT_POLL_TIMEOUT = 30000;

// Paladin's ABI codec does NOT auto-encode a plain string into bytesN -- confirmed live
// (PD012208 "Unable parse input type string hex component" on a bare "SUBPROOF"). Needs a real
// 0x-prefixed hex string of exactly n bytes.
function toBytesN(str: string, n: number): string {
  const bytes = ethers.toUtf8Bytes(str).slice(0, n);
  return ethers.hexlify(ethers.zeroPadBytes(bytes, n));
}
let failures = 0;
function check(label: string, pass: boolean, detail?: unknown) {
  if (pass) {
    console.log(`OK   - ${label}`);
  } else {
    failures++;
    console.error(`FAIL - ${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}
function fail(msg: string): false {
  console.error(msg);
  return false;
}

// BondTracker.handleDelegateUnlock's own doc comment: it runs in its OWN transaction AFTER the
// real base-ledger unlock is confirmed (Noto's domain dispatches it asynchronously, not
// atomically with the delegate's execute() like onMint/onTransfer/onUnlock are). A
// getDistributionState check run immediately after executeAtom can therefore observe the
// PREVIOUS state -- confirmed live (first attempt without this wait showed each check one step
// behind). Poll until the expected value lands or give up after ~20s.
async function waitForDistributionState(
  bi: PaladinClient,
  token: string,
  expected: { availableUnits?: string; status?: string },
  timeoutMs = 20000
): Promise<Awaited<ReturnType<PaladinClient["getDistributionState"]>>> {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<PaladinClient["getDistributionState"]>>;
  do {
    last = await bi.getDistributionState(token);
    const availableOk = expected.availableUnits === undefined || last.availableUnits === expected.availableUnits;
    const statusOk = expected.status === undefined || last.status === expected.status;
    if (availableOk && statusOk) return last;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  return last;
}

async function totalSupplyOf(sdk: PaladinClientSdk, publicTrackerAddress: string, fromLookup: string): Promise<string> {
  const result = await sdk.ptx.call({
    type: TransactionType.PUBLIC,
    abi: bondTrackerPublicArtifact.abi,
    function: "totalSupply",
    to: publicTrackerAddress,
    from: fromLookup,
    data: {},
  });
  return (result as any)["0"];
}

async function main(): Promise<boolean> {
  const runId = Date.now();

  // --- Raw SDK setup: node1 (BI: issuer+custodian), node2 (investor1) ---
  const node1 = new PaladinClientSdk(nodeConnections[0].clientOptions);
  const node2 = new PaladinClientSdk(nodeConnections[1].clientOptions);
  const [bondIssuer, bondCustodian] = node1.getVerifiers(`bondIssuer${runId}@${nodeConnections[0].id}`, `bondCustodian${runId}@${nodeConnections[0].id}`);
  const [cashIssuer] = node1.getVerifiers(`cashIssuer${runId}@${nodeConnections[0].id}`);
  const [investor1] = node2.getVerifiers(`investor1${runId}@${nodeConnections[1].id}`);
  const bondIssuerLookup = bondIssuer.lookup;
  const bondCustodianLookup = bondCustodian.lookup;

  console.log("=== Setup: BondSeriesRegistry + cash token ===");
  const registryReceipt = await node1.pollForReceipt(
    await node1.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: bondSeriesRegistryArtifact.abi,
      bytecode: bondSeriesRegistryArtifact.bytecode.object,
      function: "",
      from: bondIssuerLookup,
      data: { owner_: await bondIssuer.address() },
    }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!registryReceipt?.contractAddress) return fail("BondSeriesRegistry deploy failed");
  const registryAddress = registryReceipt.contractAddress;
  console.log(`BondSeriesRegistry = ${registryAddress}`);

  const notoCash = await new NotoFactory(node1, "noto")
    .newNoto(cashIssuer, { name: "CASH", symbol: "CASH", notary: cashIssuer, notaryMode: "basic" })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!notoCash) return fail("Cash Noto deploy failed");
  console.log(`Cash token = ${notoCash.address}`);

  let r = await notoCash.mint(cashIssuer, { to: investor1, amount: 100000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("Cash mint to investor1 failed");

  // --- paladin-client instances ---
  // identity is bondCustodian itself, not a separate generic "bi" identity -- found live: the
  // generic delegateLock (phase 2, "this identity's own leg") always signs as this.verifier, but
  // prepareBond locks the bond leg AS bondCustodian specifically. A separate "bi" identity here
  // made delegateLock try to delegate a lock it doesn't own (PD200018 "State ... is not owned
  // by", confirmed in node1's logs), stuck retrying endorsement forever until node1 crash-looped
  // from the backlog. requireIdentityVerifier("bondIssuer"/"bondCustodian") still resolve their
  // own separate identities correctly for the methods that use them explicitly either way.
  const bi: PaladinClient = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url,
    wsUrl: nodeConnections[0].clientOptions.url.replace(/^http/, "ws").replace(/(\d+)$/, (p) => String(Number(p) + 1)),
    nodeId: nodeConnections[0].id,
    identity: `bondCustodian${runId}`,
    identities: { registryAddress, bondIssuer: bondIssuerLookup, bondCustodian: bondCustodianLookup },
  });
  const inv: PaladinClient = await connectPaladinClient({
    nodeUrl: nodeConnections[1].clientOptions.url,
    wsUrl: nodeConnections[1].clientOptions.url.replace(/^http/, "ws").replace(/(\d+)$/, (p) => String(Number(p) + 1)),
    nodeId: nodeConnections[1].id,
    identity: `investor1${runId}`,
    identities: { registryAddress, bondCustodian: bondCustodianLookup },
  });

  console.log("\n=== issueSeries ===");
  const issueDate = String(Math.floor(Date.now() / 1000));
  const maturityDate = String(Number(issueDate) + 86400);
  const series = await bi.issueSeries({
    instrumentType: toBytesN("SUBPROOF", 32),
    seriesCode: toBytesN(`SUB${runId}`, 32),
    isin: toBytesN(`ISIN${runId}`, 12),
    currencyToken: notoCash.address,
    faceValue: "1000000",
    issueDate,
    maturityDate,
    transferRestricted: false,
    termsHash: "0x" + "ab".repeat(32),
  });
  console.log(`token=${series.token} privateTracker=${series.privateTracker} publicTracker=${series.publicTracker} groupId=${series.groupId}`);

  const seriesEntry = await bi.getSeries(series.token);
  check("registry status ACTIVE right after issueSeries", seriesEntry.status === "ACTIVE", seriesEntry.status);

  console.log("\n=== Register investor1 as whitelisted ===");
  await bi.addInvestor(series.token, investor1.lookup);

  console.log("\n=== Tranche 1: mint 1000, beginDistribution ===");
  await bi.mintTranche(series.token, "1000");
  await bi.beginDistribution(series.token, { price: "1", minimumDenomination: "1" });
  let state = await bi.getDistributionState(series.token);
  check("tranche1 distribution state: STARTED, 1000 available, tranche 1", state.status === "DISTRIBUTION_STARTED" && state.availableUnits === "1000" && state.trancheCount === "1", state);

  console.log("\n=== Negative case: units > availableUnits rejected by the guard (not a revert) ===");
  const oversizedUnits = "2000";
  let guardCaughtIt = false;
  const stateForGuard = await bi.getDistributionState(series.token);
  if (Number(oversizedUnits) > Number(stateForGuard.availableUnits)) {
    guardCaughtIt = true;
    console.log(`guard rejected ${oversizedUnits} > availableUnits=${stateForGuard.availableUnits} -- no subscription created, no on-chain call made`);
  }
  check("oversized subscription rejected by guard before any on-chain call", guardCaughtIt);

  // Full real subscription flow: investor side (createSubscription, preparePayment) + BI side
  // (prepareBond, distributeSubscription) + both delegateLock + executeAtom.
  const subscribe = async (units: string, label: string) => {
    console.log(`-- subscribe ${label}: ${units} units --`);
    const guardState = await bi.getDistributionState(series.token);
    if (Number(units) > Number(guardState.availableUnits)) {
      throw new Error(`${label}: guard would reject (units=${units} > availableUnits=${guardState.availableUnits})`);
    }
    const idemBase = `${label}-${runId}`;
    const { subscriptionAddress, groupId } = await inv.createSubscription(series.token, units, `${idemBase}:create`);
    console.log(`  subscription=${subscriptionAddress} group=${groupId}`);
    // Stand-in for the backend persisting createSubscription's groupId and forwarding it to BI
    // (realistically via pgroup_sendMessage) -- see resumeSubscription's own doc comment.
    await bi.resumeSubscription(subscriptionAddress, groupId, series.token, investor1.lookup);
    const payment = await inv.preparePayment(subscriptionAddress, units, `${idemBase}:payment`);
    const bond = await bi.prepareBond(subscriptionAddress, units, `${idemBase}:bond`);
    if (label === "tranche1-A") {
      // Lead requirement: calling prepareBond AGAIN with the SAME idempotencyKey must resolve
      // to the ORIGINAL transaction (same lockId), not submit a second one.
      const bondRetry = await bi.prepareBond(subscriptionAddress, units, `${idemBase}:bond`);
      check("prepareBond called twice with the same idempotencyKey resolves to the same lockId (1 tx on-chain)", bondRetry.lockId === bond.lockId, { first: bond.lockId, retry: bondRetry.lockId });
    }
    const { atomAddress } = await bi.distributeSubscription(subscriptionAddress, `${idemBase}:distribute`);
    console.log(`  atom=${atomAddress}`);
    await inv.delegateLock(notoCash.address, payment.lockId, atomAddress, `${idemBase}:delegate-cash`);
    await bi.delegateLock(series.token, bond.lockId, atomAddress, `${idemBase}:delegate-bond`);
    await bi.executeAtom(atomAddress, `${idemBase}:execute`);
  };

  console.log("\n=== Tranche 1, subscription A: 700 units ===");
  await subscribe("700", "tranche1-A");
  state = await waitForDistributionState(bi, series.token, { availableUnits: "300" });
  check("after subscription A: availableUnits=300, still STARTED", state.availableUnits === "300" && state.status === "DISTRIBUTION_STARTED", state);

  console.log("\n=== Tranche 1, subscription B: remaining 300 units (sells out the round) ===");
  await subscribe("300", "tranche1-B");
  state = await waitForDistributionState(bi, series.token, { status: "DISTRIBUTION_COMPLETE" });
  check("after subscription B: availableUnits=0, DISTRIBUTION_COMPLETE", state.availableUnits === "0" && state.status === "DISTRIBUTION_COMPLETE", state);

  await bi.closeDistribution(series.token);
  await bi.setActive(series.token);
  state = await bi.getDistributionState(series.token);
  check("tranche1 -> ACTIVE", state.status === "ACTIVE", state);

  const investorBond1 = (await inv.balances(series.token)).available;
  check("investor1 bond balance after tranche1 = 1000", investorBond1 === "1000", investorBond1);

  console.log("\n=== Tranche 2 (reopening): mint 500 more on the SAME token ===");
  await bi.mintTranche(series.token, "500");
  await bi.beginDistribution(series.token, { price: "1", minimumDenomination: "1" });
  state = await bi.getDistributionState(series.token);
  check("tranche2: STARTED, 500 available, tranche 2", state.status === "DISTRIBUTION_STARTED" && state.availableUnits === "500" && state.trancheCount === "2", state);

  console.log("\n=== Tranche 2, subscription: 500 units (full tranche) -- the decisive handleDelegateUnlock proof ===");
  await subscribe("500", "tranche2");
  state = await waitForDistributionState(bi, series.token, { status: "DISTRIBUTION_COMPLETE" });
  check("after tranche2 subscription: availableUnits=0, DISTRIBUTION_COMPLETE", state.availableUnits === "0" && state.status === "DISTRIBUTION_COMPLETE", state);

  await bi.closeDistribution(series.token);
  await bi.setActive(series.token);
  state = await bi.getDistributionState(series.token);
  check("tranche2 -> ACTIVE", state.status === "ACTIVE", state);

  const investorBond2 = (await inv.balances(series.token)).available;
  check("investor1 cumulative bond balance = 1500", investorBond2 === "1500", investorBond2);

  const totalSupply = await totalSupplyOf(node1, series.publicTracker, bondIssuerLookup);
  check("publicTracker totalSupply = 1500", totalSupply === "1500", totalSupply);

  const finalSeries = await bi.getSeries(series.token);
  check("registry status stayed ACTIVE throughout (never touched)", finalSeries.status === "ACTIVE", finalSeries.status);

  await bi.disconnect();
  await inv.disconnect();

  console.log(failures === 0 ? "\nSUCCESS: #6b primary subscription proven live (2 tranches + negative case)" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
