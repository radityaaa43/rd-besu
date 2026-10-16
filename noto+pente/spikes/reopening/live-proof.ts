/*
 * Live proof for lead task #7 part B: the forked BondTracker (private) + BondTrackerPublic
 * (public) actually support reopening (tap issuance) end-to-end on a scratch series --
 * mint tranche1 -> distribute to investor1 -> ACTIVE -> reopen (mint tranche2 on the SAME
 * token) -> distribute to investor2 -> ACTIVE, then checks balances/totalSupply/events, plus a
 * negative case (reopening while distribution 1 is still open -> revert).
 *
 * Uses the FORKED artifacts compiled by `forge build` in Paladin/contracts/out/ (NOT
 * Paladin/bond/src/abis/BondTracker.json, which is the ORIGINAL unforked contract) -- this is
 * the whole point of this proof: exercising the actual fork, not the upstream original.
 *
 * Simplified vs the full bond/src/index.ts flow: distribution here is a plain Noto `transfer()`
 * from custodian to investor (no lock/Atom/DvP) -- BondTracker.onTransfer already triggers the
 * public onDistribute() PenteExternalCall whenever `_status==DISTRIBUTION_STARTED && from ==
 * _custodian`, so a direct transfer is enough to drive the status machine. The DvP/Atom
 * mechanism itself is already proven extensively elsewhere this session; this proof is scoped
 * to reopening only.
 *
 * Run: NODE_PATH=../../bond/node_modules ../../bond/node_modules/.bin/ts-node live-proof.ts
 */
import PaladinClient, {
  NotoFactory,
  PaladinVerifier,
  PenteFactory,
  PentePrivacyGroup,
  PentePrivateContract,
  TransactionType,
} from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "paladin-example-common";
import bondTrackerArtifact from "../../contracts/out/BondTracker.sol/BondTracker.json";
import bondTrackerPublicArtifact from "../../contracts/out/BondTrackerPublic.sol/BondTrackerPublic.json";
import { connect as connectPaladinClient } from "../../common/paladin-client/src/index";

const DEFAULT_POLL_TIMEOUT = 30000;

class ForkedBondTracker extends PentePrivateContract<unknown> {
  constructor(protected evm: PentePrivacyGroup, public readonly address: string) {
    super(evm, bondTrackerArtifact.abi, address);
  }
  using(paladin: PaladinClient) {
    return new ForkedBondTracker(this.evm.using(paladin), this.address);
  }
  onMintViaNoto() {
    throw new Error("unused -- minting happens through the Noto token, not this wrapper");
  }
  beginDistribution(from: PaladinVerifier, params: { discountPrice: number; minimumDenomination: number }) {
    return this.sendTransaction({ from: from.lookup, function: "beginDistribution", data: params });
  }
  closeDistribution(from: PaladinVerifier) {
    return this.sendTransaction({ from: from.lookup, function: "closeDistribution", data: {} });
  }
  setActive(from: PaladinVerifier) {
    return this.sendTransaction({ from: from.lookup, function: "setActive", data: {} });
  }
  async investorList(from: PaladinVerifier) {
    const result = await this.call({ from: from.lookup, function: "investorList" });
    return result[0] as string;
  }
}

class InvestorListWrapper extends PentePrivateContract<unknown> {
  constructor(protected evm: PentePrivacyGroup, public readonly address: string) {
    super(evm, [{ type: "function", name: "addInvestor", inputs: [{ name: "addr", type: "address" }], outputs: [], stateMutability: "nonpayable" }], address);
  }
  using(paladin: PaladinClient) {
    return new InvestorListWrapper(this.evm.using(paladin), this.address);
  }
  addInvestor(from: PaladinVerifier, addr: string) {
    return this.sendTransaction({ from: from.lookup, function: "addInvestor", data: { addr } });
  }
}

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};

async function deployPublicTracker(paladin: PaladinClient, from: PaladinVerifier, owner: string, currencyToken: string) {
  const issueDate = Math.floor(Date.now() / 1000);
  const maturityDate = issueDate + 86400;
  const txId = await paladin.ptx.sendTransaction({
    type: TransactionType.PUBLIC,
    abi: bondTrackerPublicArtifact.abi,
    bytecode: bondTrackerPublicArtifact.bytecode.object,
    function: "",
    from: from.lookup,
    // owner MUST be the Pente privacy group's own base-ledger address (group.address), not the
    // signer's EOA -- PenteExternalCall's msg.sender into this contract is the group, so
    // onlyOwner only ever accepts that address. Confirmed against examples/bond/src/index.ts:114
    // (`owner: issuerCustodianGroup.address`) after a live OwnableUnauthorizedAccount revert.
    data: { owner, issueDate_: issueDate, maturityDate_: maturityDate, currencyToken_: currencyToken, faceValue_: 1 },
  });
  const r = await paladin.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT);
  if (!r?.contractAddress) throw new Error("BondTrackerPublic deploy failed");
  return r.contractAddress;
}

function publicTrackerView(paladin: PaladinClient, address: string) {
  return {
    async totalSupply() {
      // Auto-generated public-variable getters have an unnamed output, so ptx_call returns it
      // keyed by index "0", not by the function's own name -- confirmed live via raw ptx_call.
      const r = await paladin.ptx.call({ type: TransactionType.PUBLIC, abi: bondTrackerPublicArtifact.abi, function: "totalSupply", to: address, from: address, data: {} });
      return (r as any)["0"] as string;
    },
    async trancheCount() {
      const r = await paladin.ptx.call({ type: TransactionType.PUBLIC, abi: bondTrackerPublicArtifact.abi, function: "trancheCount", to: address, from: address, data: {} });
      return (r as any)["0"] as string;
    },
  };
}

async function main(): Promise<boolean> {
  if (nodeConnections.length < 4) {
    console.error("Need 4 nodes configured.");
    return false;
  }
  const runId = Date.now();
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const node1 = clients[0]; // issuer + custodian, single identity for this proof
  const [issuerCustodian] = node1.getVerifiers(`reopenIC${runId}@${nodeConnections[0].id}`);
  const investor1Client = clients[1];
  const [investor1] = investor1Client.getVerifiers(`reopenInv1_${runId}@${nodeConnections[1].id}`);
  const investor2Client = clients[2];
  const [investor2] = investor2Client.getVerifiers(`reopenInv2_${runId}@${nodeConnections[2].id}`);

  console.log("=== Deploy: group, public tracker, private tracker, Noto bond token ===");
  const group = await new PenteFactory(node1, "pente")
    .newPrivacyGroup({ members: [issuerCustodian], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!group) return fail("group deploy failed");

  const publicTrackerAddress = await deployPublicTracker(node1, issuerCustodian, group.address, "0x0000000000000000000000000000000000000001");
  console.log(`BondTrackerPublic (forked) = ${publicTrackerAddress}`);

  const custodianAddr = await issuerCustodian.address();
  const trackerAddress = await group
    .deploy({ abi: bondTrackerArtifact.abi, bytecode: bondTrackerArtifact.bytecode.object, from: issuerCustodian.lookup, inputs: { name: "REOPENBOND", symbol: "RPB", custodian: custodianAddr, publicTracker: publicTrackerAddress } })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!trackerAddress) return fail("BondTracker deploy failed");
  console.log(`BondTracker (forked) = ${trackerAddress}`);
  const tracker = new ForkedBondTracker(group, trackerAddress);

  const investorListAddress = await tracker.investorList(issuerCustodian);
  const investorList = new InvestorListWrapper(group, investorListAddress);
  let r = await investorList.addInvestor(issuerCustodian, await investor1.address()).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("addInvestor(1) failed");
  r = await investorList.addInvestor(issuerCustodian, await investor2.address()).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("addInvestor(2) failed");

  const notoBond = await new NotoFactory(node1, "noto")
    .newNoto(issuerCustodian, { name: "REOPENBOND", symbol: "RPB", notary: issuerCustodian, notaryMode: "hooks", options: { hooks: { privateGroup: group, publicAddress: group.address, privateAddress: trackerAddress } } })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!notoBond) return fail("Noto bond deploy failed");
  console.log(`Noto bond token = ${notoBond.address}`);

  const pub = publicTrackerView(node1, publicTrackerAddress);

  // Listen for TrancheIssued(trancheNo, amount) using paladin-client itself (dogfooding the
  // package built in task #4/#4b) -- bonus proof it works for a real use case, and the
  // decisive way to check "2 TrancheIssued events" live rather than re-deriving it from state.
  const trancheEvents: { trancheNo: string; amount: string }[] = [];
  // WS port = HTTP port + 1 (Paladin/scripts/port-forward-start.sh's convention), NOT the same
  // port with just the scheme swapped -- that hits the HTTP-only port and gets a 405 forever.
  const httpUrl = new URL(nodeConnections[0].clientOptions.url);
  const wsUrl = `ws://${httpUrl.hostname}:${Number(httpUrl.port) + 1}`;
  const eventClient = await connectPaladinClient({ nodeUrl: nodeConnections[0].clientOptions.url, wsUrl, nodeId: nodeConnections[0].id, identity: `reopenIC${runId}` });
  const eventListenerName = `reopen-tranche-events-${runId}`;
  const eventHandle = await eventClient.onBlockchainEvent(eventListenerName, publicTrackerAddress, "TrancheIssued(uint256 trancheNo, uint256 amount)", async (e) => {
    const data = e.data as { trancheNo: string; amount: string };
    trancheEvents.push({ trancheNo: data.trancheNo, amount: data.amount });
  });

  // ===== Tranche 1 =====
  console.log("\n=== Tranche 1: mint 1000, distribute all to investor1, -> ACTIVE ===");
  r = await notoBond.mint(issuerCustodian, { to: issuerCustodian, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche1 mint failed: " + r?.failureMessage);
  console.log(`tranche1 mint tx=${r.id}`);

  r = await tracker.beginDistribution(issuerCustodian, { discountPrice: 1, minimumDenomination: 1 }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche1 beginDistribution failed: " + r?.failureMessage);

  r = await notoBond.transfer(issuerCustodian, { to: investor1, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche1 transfer failed: " + r?.failureMessage);
  console.log(`tranche1 distribute tx=${r.id}`);

  r = await tracker.closeDistribution(issuerCustodian).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche1 closeDistribution failed: " + r?.failureMessage);
  r = await tracker.setActive(issuerCustodian).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche1 setActive failed: " + r?.failureMessage);
  console.log("tranche1 -> ACTIVE, no revert");

  const inv1AfterT1 = await notoBond.using(investor1Client).balanceOf(investor1, { account: investor1.lookup });
  check("investor1 balance after tranche1", inv1AfterT1.totalBalance === "1000", inv1AfterT1.totalBalance);
  check("public totalSupply after tranche1", (await pub.totalSupply()) === "1000", await pub.totalSupply());
  check("public trancheCount after tranche1", (await pub.trancheCount()) === "1", await pub.trancheCount());

  // ===== Negative case: reopen while distribution 1 is still open =====
  console.log("\n=== Negative case: mint a second tranche while status != INITIALIZED/ACTIVE must revert ===");
  // Fresh scratch instance for this check so it doesn't disturb the main 2-tranche proof: mint
  // tranche1 and begin distribution (status=DISTRIBUTION_STARTED), then attempt a second mint.
  const negGroup = await new PenteFactory(node1, "pente").newPrivacyGroup({ members: [issuerCustodian], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  const negPublicAddr = await deployPublicTracker(node1, issuerCustodian, negGroup!.address, "0x0000000000000000000000000000000000000001");
  const negTrackerAddr = await negGroup!.deploy({ abi: bondTrackerArtifact.abi, bytecode: bondTrackerArtifact.bytecode.object, from: issuerCustodian.lookup, inputs: { name: "NEG", symbol: "NEG", custodian: custodianAddr, publicTracker: negPublicAddr } }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  const negTracker = new ForkedBondTracker(negGroup!, negTrackerAddr!);
  const negNoto = await new NotoFactory(node1, "noto").newNoto(issuerCustodian, { name: "NEG", symbol: "NEG", notary: issuerCustodian, notaryMode: "hooks", options: { hooks: { privateGroup: negGroup!, publicAddress: negGroup!.address, privateAddress: negTrackerAddr! } } }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!negNoto) return fail("negative-case Noto deploy failed");

  r = await negNoto.mint(issuerCustodian, { to: issuerCustodian, amount: 100, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("negative-case tranche1 mint failed");
  r = await negTracker.beginDistribution(issuerCustodian, { discountPrice: 1, minimumDenomination: 1 }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("negative-case beginDistribution failed");
  console.log("negative-case: status is now DISTRIBUTION_STARTED (not ACTIVE) -- attempting a second mint...");

  const negMintReceipt = await negNoto.mint(issuerCustodian, { to: issuerCustodian, amount: 50, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  // An assemble-time revert (the case here -- the private onMint gate rejects before the tx
  // ever reaches the chain) never sets `success` at all, it only sets `failureMessage` --
  // confirmed live. `success === true` is therefore the only thing that means "did not revert".
  check(
    "second mint while DISTRIBUTION_STARTED reverts",
    negMintReceipt !== undefined && negMintReceipt.success !== true && !!negMintReceipt.failureMessage,
    JSON.stringify({ success: negMintReceipt?.success, failureMessage: negMintReceipt?.failureMessage })
  );

  // ===== Tranche 2 (reopening) =====
  console.log("\n=== Tranche 2 (reopening): mint 500 more on the SAME token, distribute to investor2, -> ACTIVE ===");
  r = await notoBond.mint(issuerCustodian, { to: issuerCustodian, amount: 500, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche2 mint failed (THE FIX UNDER TEST): " + r?.failureMessage);
  console.log(`tranche2 mint tx=${r.id} -- did NOT revert (this is the fix)`);

  r = await tracker.beginDistribution(issuerCustodian, { discountPrice: 1, minimumDenomination: 1 }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche2 beginDistribution failed (THE FIX UNDER TEST): " + r?.failureMessage);
  console.log("tranche2 beginDistribution -- did NOT revert (this is the fix)");

  r = await notoBond.transfer(issuerCustodian, { to: investor2, amount: 500, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche2 transfer failed: " + r?.failureMessage);
  console.log(`tranche2 distribute tx=${r.id}`);

  r = await tracker.closeDistribution(issuerCustodian).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche2 closeDistribution failed: " + r?.failureMessage);
  r = await tracker.setActive(issuerCustodian).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return fail("tranche2 setActive failed: " + r?.failureMessage);
  console.log("tranche2 -> ACTIVE, no revert");

  const inv1Final = await notoBond.using(investor1Client).balanceOf(investor1, { account: investor1.lookup });
  const inv2Final = await notoBond.using(investor2Client).balanceOf(investor2, { account: investor2.lookup });
  const finalTotalSupply = await pub.totalSupply();
  const finalTrancheCount = await pub.trancheCount();

  check("investor1 balance unchanged by tranche2", inv1Final.totalBalance === "1000", inv1Final.totalBalance);
  check("investor2 balance == tranche2 amount", inv2Final.totalBalance === "500", inv2Final.totalBalance);
  check(
    "sum of investor balances == public totalSupply",
    BigInt(inv1Final.totalBalance) + BigInt(inv2Final.totalBalance) === BigInt(finalTotalSupply),
    `${inv1Final.totalBalance} + ${inv2Final.totalBalance} = ${BigInt(inv1Final.totalBalance) + BigInt(inv2Final.totalBalance)}, totalSupply=${finalTotalSupply}`
  );
  check("public totalSupply == 1500 (cumulative)", finalTotalSupply === "1500", finalTotalSupply);
  check("public trancheCount == 2", finalTrancheCount === "2", finalTrancheCount);

  // Give the event listener a moment to receive and ack the last batch.
  await new Promise((r) => setTimeout(r, 3000));
  check(
    "exactly 2 TrancheIssued events, (1,1000) then (2,500)",
    trancheEvents.length === 2 && trancheEvents[0].trancheNo === "1" && trancheEvents[0].amount === "1000" && trancheEvents[1].trancheNo === "2" && trancheEvents[1].amount === "500",
    JSON.stringify(trancheEvents)
  );
  await eventHandle.stop();
  await eventClient.disconnect();

  console.log(failures === 0 ? "\nSUCCESS: reopening fork proven live (2 tranches + 1 negative case)" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

function fail(msg: string): false {
  console.error(msg);
  return false;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
