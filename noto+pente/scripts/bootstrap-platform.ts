/*
 * Task #9: platform bootstrap for real mode. Deploys the base contracts the backend needs
 * before any real-mode flow can run, and writes one contract-data-<bank>.json per bank --
 * 0.3.2 (lead decision): EXACTLY `PaladinClientConfig` minus `nodeUrl`/`wsUrl`/`rpcAuth` (those
 * only ever come from env/runtime, never a static file). paladin-client's own
 * `loadClientConfigFile(path, {nodeUrl, wsUrl?, rpcAuth?})` is the only correct way to turn
 * this file back into a real config -- the backend must call that, never build its own
 * mapping (that drift is exactly what caused the 0.3.0/0.3.1 "known gap" this script used to
 * carry; now closed, see git history / CHANGELOG for the old version of this comment).
 *
 * Task #10 (2026-10-06, updated for paladin-client 0.4.0): no change needed for
 * `identities.bondIssuer`/`contractData.restrictedAtomFactoryAddress`/`cashToken` or the old
 * upstream AtomFactory -- all already correct from task #9 (this script never referenced the
 * removed `AtomFactory`/`BondSubscription` path). What's new: pre-creates each investor's own
 * investor+custodian Agreement group (D1) and records it -- `identities.
 * investorCustodianGroupId` on that investor's OWN file (paladin-client's typed field,
 * "only meaningful on an investor-identity client"), `contractData.groupIds` (an opaque
 * bankId->groupId map) on BI's file, since BI's one client manages every investor
 * relationship, not one. Every contract-data file (dry-run AND real) is now checked against
 * `validateClientConfig` directly, not just round-tripped through `loadClientConfigFile` at
 * `--execute` time -- a shape mistake surfaces in the dry run, before anything is deployed.
 *
 * Deploys (see printPlan() below for the authoritative, numbered list):
 * - Cash Noto token (RD): hooks mode, notary = cashIssuer@node1 -- a SEPARATE identity from
 *   bondCustodian@node1 (lead decision, 2026-10-05: "separation of roles: the RD issuer vs
 *   the DFABI custodian"). bondCustodian stays the registry owner and the bond's
 *   custodian/executor; it is never the cash notary. Confirmed nothing in paladin-client
 *   assumes otherwise: verifyDelegatedLeg/verifyCancelCall's node-level state reads use
 *   `this.verifier.lookup` (whichever identity the calling client itself is) only as the
 *   `from` on an eth_call/pstate query -- not as an assumed notary -- and since cashIssuer
 *   and bondCustodian are both node1 identities, BI's own client (connected as bondCustodian
 *   on node1) sees the SAME local state store pstate_queryContractStates would return for
 *   ANY node1 identity, cash token included. Nothing else in client.ts reads or compares a
 *   "cash notary" identity at all -- lock/prepareUnlock/delegateLock/mint only care about
 *   `tokenAddress`, never about who that token's notary happens to be.
 * - BondSeriesRegistry(owner = bondCustodian@node1) -- a plain public contract. paladin-client
 *   itself never deploys this (confirmed by reading client.ts: requireRegistryAddress only
 *   READS config.identities.registryAddress, never deploys), so it must be bootstrapped
 *   separately -- this is that separate step.
 * - RestrictedAtomFactory -- also deploys its own RestrictedAtom logic/implementation
 *   internally in the SAME constructor call (confirmed from RestrictedAtomFactory.sol:
 *   `constructor() { logic = address(new RestrictedAtom()); }`) -- "(+ implementation)" in
 *   the task description does not mean a second, separate deploy step.
 * - Mints `--initial-cash` (default 1,000,000) cash to each of the 3 investor identities.
 * - Creates one investor+custodian Agreement privacy group per investor (task #10, D1) --
 *   members=[investor, bondCustodian@node1], same shape ensureInvestorCustodianGroup's own
 *   create branch builds.
 *
 * Identities ("minimal... per participants", matching backend/shared/config/participants.json
 * plus the lead's cashIssuer addition -- no other identity invented): bondCustodian@node1 (BI,
 * registry owner, bond custodian/executor), cashIssuer@node1 (RD/cash notary), investor2@node2,
 * investor3@node3, investor4@node4.
 *
 * IDEMPOTENT: if Paladin/bootstrap/out/contract-data-bank1.json already exists, the whole
 * bootstrap is skipped (prints why, exits 0) -- re-running after a successful run is a safe
 * no-op, never a re-deploy. Delete the out/ directory's contract-data-*.json files to force a
 * fresh run.
 *
 * SAFE BY DEFAULT: dry-run unless --execute is passed. Dry-run prints the full numbered plan
 * AND the full content every contract-data-<bank>.json file would get (addresses as "<tbd>",
 * since nothing has been deployed) -- sends NOTHING, writes NOTHING.
 *
 * Run (dry-run, default, safe): ts-node bootstrap-platform.ts
 * Run (real, ONLY after explicit user approval): ts-node bootstrap-platform.ts --execute
 * Optional: --initial-cash=<amount> (default 1000000)
 *
 * Run from this directory:
 *   NODE_PATH=../bond/node_modules:../swap-noto/node_modules ../bond/node_modules/.bin/ts-node bootstrap-platform.ts
 */
import * as fs from "fs";
import * as path from "path";
import PaladinClient, { NotoFactory, NotoInstance, PenteFactory, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, checkDeploy, checkReceipt, nodeConnections } from "paladin-example-common";
import { loadClientConfigFile, validateClientConfig } from "../common/paladin-client/src/index";
import type { PaladinClientConfig } from "../common/paladin-client/src/types";
import { newERC20Tracker } from "../bond/src/helpers/erc20tracker";
import bondSeriesRegistryArtifact from "../common/paladin-client/src/abis/BondSeriesRegistry.json";
import restrictedAtomFactoryArtifact from "../common/paladin-client/src/abis/RestrictedAtomFactory.json";

const logger = console;
const OUT_DIR = path.join(__dirname, "..", "bootstrap", "out");

interface Participant {
  bankId: string;
  role: "BI" | "investor";
  lookup: string;
  nodeIdx: number;
}
// Matches backend/shared/config/participants.json plus the lead's cashIssuer addition.
// cashIssuer has no own bank/backend process -- it's a second BI-side identity, same node1,
// never given its own contract-data-<bank>.json file.
const PARTICIPANTS: Participant[] = [
  { bankId: "bank1", role: "BI", lookup: "bondCustodian@node1", nodeIdx: 0 },
  { bankId: "bank2", role: "investor", lookup: "investor2@node2", nodeIdx: 1 },
  { bankId: "bank3", role: "investor", lookup: "investor3@node3", nodeIdx: 2 },
  { bankId: "bank4", role: "investor", lookup: "investor4@node4", nodeIdx: 3 },
];
const CASH_ISSUER_LOOKUP = "cashIssuer@node1";
const BOND_ISSUER_LOOKUP = "bondIssuer@node1";
const BI = PARTICIPANTS[0];
const INVESTORS = PARTICIPANTS.filter((p) => p.role === "investor");

interface PlanStep {
  n: number;
  action: string;
  from: string;
  txCount: number;
}

function parseArgs(): { execute: boolean; initialCashPerInvestor: string } {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const cashArg = args.find((a) => a.startsWith("--initial-cash="));
  const initialCashPerInvestor = cashArg ? cashArg.split("=")[1] : "1000000";
  return { execute, initialCashPerInvestor };
}

function bankFile(bankId: string): string {
  return path.join(OUT_DIR, `contract-data-${bankId}.json`);
}

// The exact shape every contract-data-<bank>.json gets: PaladinClientConfig minus
// nodeUrl/wsUrl/rpcAuth. `registryAddress`/`bondCustodian`/`restrictedAtomFactoryAddress` are
// the 3 fields loadClientConfigFile's validateClientConfig actually requires; `cashToken` rides
// along in the opaque contractData bag for the backend's own use (paladin-client itself never
// reads it).
//
// Task #10 (2026-10-06): pre-create each investor's own investor+custodian Agreement group
// (D1's `ensurePrimaryGroup`/`getOrCreateInvestorCustodianGroup`) so an investor's FIRST real
// primary-subscription call doesn't pay group-creation cost or need runtime discovery.
// `identities.investorCustodianGroupId` is paladin-client's own TYPED field for this -- "only
// meaningful on an investor-identity client" (types.ts's own doc comment) -- so it's set ONLY
// on each investor's own file, to THEIR OWN group id, never on BI's. BI's single client
// manages a relationship with EVERY investor (not one), so there's no single
// `investorCustodianGroupId` that would fit BI's file; `contractData.groupIds` (an opaque bag,
// BI's backend's own bookkeeping, paladin-client itself never reads it) instead maps every
// investor's bankId to its group id on BI's file, so BI's backend doesn't need
// findGroupsWithMembers at runtime to resolve a group it already knows.
function buildBankConfig(
  p: Participant,
  addresses: { cashToken: string; registryAddress: string; restrictedAtomFactoryAddress: string },
  groupIds: Record<string, string>
): Omit<PaladinClientConfig, "nodeUrl" | "wsUrl" | "rpcAuth"> {
  return {
    nodeId: nodeConnections[p.nodeIdx].id,
    identity: p.lookup.split("@")[0],
    identities: {
      registryAddress: addresses.registryAddress,
      bondCustodian: BI.lookup,
      // C7/D4 (architecture review, 2026-10-05): the backend's own real.ts needs this for
      // issueSeries/mintTranche -- omitting it was one of the two reasons real-mode config
      // could never load. Not a separate identity this script provisions (Paladin has no
      // "create identity" RPC -- identities are just node-local signing key references,
      // confirmed earlier this session), just a naming convention written into the file.
      bondIssuer: BOND_ISSUER_LOOKUP,
      // Task #26 (real incident, 2026-10-07): fundIssuer/transferCash(fromIdentity: "cashIssuer")
      // need config.identities.cashIssuer, but it was never written here -- only BI ever signs
      // as cashIssuer (RD mint/fund is a BI-only operation), so it's added for BI only, same
      // conditional pattern as investorCustodianGroupId below.
      ...(p.role === "BI" ? { cashIssuer: CASH_ISSUER_LOOKUP } : {}),
      ...(p.role === "investor" ? { investorCustodianGroupId: groupIds[p.bankId] } : {}),
    },
    contractData: {
      restrictedAtomFactoryAddress: addresses.restrictedAtomFactoryAddress,
      cashToken: addresses.cashToken,
      ...(p.role === "BI" ? { groupIds } : {}),
    },
  };
}

function buildPlan(initialCashPerInvestor: string): PlanStep[] {
  let n = 0;
  const steps: PlanStep[] = [
    { n: ++n, action: "Create a cashIssuer-only Pente privacy group (for the cash ERC20Tracker)", from: CASH_ISSUER_LOOKUP, txCount: 1 },
    { n: ++n, action: "Deploy the private ERC20Tracker (cash) into that group", from: CASH_ISSUER_LOOKUP, txCount: 1 },
    { n: ++n, action: "Deploy the Noto cash token (RD): notary=cashIssuer@node1 (separate from bondCustodian), notaryMode=hooks, backed by the tracker above", from: CASH_ISSUER_LOOKUP, txCount: 1 },
    { n: ++n, action: "Deploy BondSeriesRegistry(owner=bondCustodian@node1)", from: BI.lookup, txCount: 1 },
    { n: ++n, action: "Deploy RestrictedAtomFactory (also deploys its own RestrictedAtom logic/implementation internally, same tx -- see constructor() in RestrictedAtomFactory.sol)", from: BI.lookup, txCount: 1 },
  ];
  for (const inv of INVESTORS) {
    steps.push({ n: ++n, action: `Mint ${initialCashPerInvestor} cash to ${inv.lookup}`, from: CASH_ISSUER_LOOKUP, txCount: 1 });
  }
  for (const inv of INVESTORS) {
    // Task #10: pre-create this investor's own investor+custodian Agreement group (D1's
    // ensurePrimaryGroup), same shape ensureInvestorCustodianGroup's create branch builds --
    // members=[investor, bondCustodian], shanghai, externalCallsEnabled true.
    steps.push({ n: ++n, action: `Create investor+custodian Agreement group for ${inv.lookup} (bondCustodian + ${inv.lookup})`, from: BI.lookup, txCount: 1 });
  }
  return steps;
}

function printPlan(plan: PlanStep[], initialCashPerInvestor: string): void {
  logger.log("=== Platform bootstrap plan ===");
  for (const s of plan) {
    logger.log(`  ${s.n}. [tx] ${s.action} (from ${s.from})`);
  }
  const totalTx = plan.reduce((sum, s) => sum + s.txCount, 0);
  logger.log(`\nEstimated transaction count: ${totalTx}`);
  logger.log(`Identities used for deploys: ${BI.lookup} (BI), ${CASH_ISSUER_LOOKUP} (cash notary, separate from BI), ${INVESTORS.map((p) => p.lookup).join(", ")}`);
  logger.log(`Identities written into every contract-data file (not deployed, just recorded): + ${BOND_ISSUER_LOOKUP} (identities.bondIssuer, needed by the backend's issueSeries/mintTranche -- C7/D4)`);
  logger.log(`Initial cash per investor: ${initialCashPerInvestor}`);
  logger.log(`\nOutput: one file per bank in ${OUT_DIR}/`);
  const tbd = { cashToken: "<tbd>", registryAddress: "<tbd>", restrictedAtomFactoryAddress: "<tbd>" };
  const tbdGroupIds: Record<string, string> = {};
  for (const inv of INVESTORS) tbdGroupIds[inv.bankId] = "<tbd>";
  for (const p of PARTICIPANTS) {
    const config = buildBankConfig(p, tbd, tbdGroupIds);
    logger.log(`\n${bankFile(p.bankId)}:`);
    logger.log(JSON.stringify(config, null, 2));
    // Task #10: every contract-data file must pass validateClientConfig from 0.4.0, checked
    // right here in the dry run -- a shape mistake surfaces now, not at the backend's next
    // startup. nodeUrl is added only because the TYPE requires it (the file itself never
    // stores it -- loadClientConfigFile injects the real one at load time); its value is
    // never checked by validateClientConfig.
    validateClientConfig({ ...config, nodeUrl: "http://<tbd>" });
    logger.log(`  -> validateClientConfig: OK`);
  }
}

async function main(): Promise<boolean> {
  const { execute, initialCashPerInvestor } = parseArgs();

  if (nodeConnections.length < 4) {
    logger.error("Need 4 nodes configured.");
    return false;
  }

  const biFile = bankFile(BI.bankId);
  if (fs.existsSync(biFile)) {
    logger.log(`IDEMPOTENT SKIP: ${biFile} already exists -- platform already bootstrapped.`);
    logger.log(`Delete contract-data-*.json in ${OUT_DIR}/ to force a fresh run.`);
    return true;
  }

  const plan = buildPlan(initialCashPerInvestor);
  printPlan(plan, initialCashPerInvestor);

  if (!execute) {
    logger.log("\nDRY RUN -- no transaction sent, no file written. Pass --execute to actually deploy (after explicit approval).");
    return true;
  }

  logger.log("\n=== EXECUTING (--execute passed) ===");
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const biClient = clients[BI.nodeIdx];
  const [biVerifier] = biClient.getVerifiers(BI.lookup);
  const [cashIssuerVerifier] = biClient.getVerifiers(CASH_ISSUER_LOOKUP);
  const investors = INVESTORS.map((inv) => ({
    ...inv,
    client: clients[inv.nodeIdx],
    verifier: clients[inv.nodeIdx].getVerifiers(inv.lookup)[0],
  }));

  const notoFactory = new NotoFactory(biClient, "noto");
  const penteFactory = new PenteFactory(biClient, "pente");

  logger.log("1. Creating cashIssuer-only cash privacy group...");
  const cashGroup = await penteFactory
    .newPrivacyGroup({ members: [cashIssuerVerifier], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(cashGroup)) return false;

  logger.log("2. Deploying private cash ERC20Tracker...");
  const cashTracker = await newERC20Tracker(cashGroup, cashIssuerVerifier, { name: "RD", symbol: "RD" });
  if (!checkDeploy(cashTracker)) return false;

  logger.log("3. Deploying Noto cash token (RD)...");
  const cashToken = await notoFactory
    .newNoto(cashIssuerVerifier, {
      name: "RD",
      symbol: "RD",
      notary: cashIssuerVerifier,
      notaryMode: "hooks",
      options: { hooks: { privateGroup: cashGroup, publicAddress: cashGroup.address, privateAddress: cashTracker!.address } },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(cashToken)) return false;

  logger.log("4. Deploying BondSeriesRegistry...");
  const biAddress = await biVerifier.address();
  const registryReceipt = await biClient.pollForReceipt(
    await biClient.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: bondSeriesRegistryArtifact.abi,
      bytecode: (bondSeriesRegistryArtifact as any).bytecode.object,
      function: "",
      from: biVerifier.lookup,
      data: { owner_: biAddress },
    }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!checkReceipt(registryReceipt) || !registryReceipt.contractAddress) return false;
  const registryAddress = registryReceipt.contractAddress;

  logger.log("5. Deploying RestrictedAtomFactory...");
  const atomFactoryReceipt = await biClient.pollForReceipt(
    await biClient.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: restrictedAtomFactoryArtifact.abi,
      bytecode: (restrictedAtomFactoryArtifact as any).bytecode.object,
      function: "",
      from: biVerifier.lookup,
      data: {},
    }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!checkReceipt(atomFactoryReceipt) || !atomFactoryReceipt.contractAddress) return false;
  const restrictedAtomFactoryAddress = atomFactoryReceipt.contractAddress;

  for (const inv of investors) {
    logger.log(`Minting ${initialCashPerInvestor} cash to ${inv.lookup}...`);
    const receipt = await (cashToken as NotoInstance).mint(cashIssuerVerifier, { to: inv.verifier, amount: initialCashPerInvestor, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;
  }

  // Task #10: pre-create each investor's own investor+custodian Agreement group -- same shape
  // ensureInvestorCustodianGroup's create branch builds (members=[investor, bondCustodian],
  // shanghai, externalCallsEnabled true), so an investor's first real primary-subscription
  // call resumes this group instead of creating (or discovering) one at runtime.
  const groupIds: Record<string, string> = {};
  for (const inv of investors) {
    logger.log(`Creating investor+custodian Agreement group for ${inv.lookup}...`);
    const group = await penteFactory
      .newPrivacyGroup({ members: [inv.verifier, biVerifier], evmVersion: "shanghai", externalCallsEnabled: true })
      .waitForDeploy(DEFAULT_POLL_TIMEOUT);
    if (!checkDeploy(group)) return false;
    groupIds[inv.bankId] = group!.group.id;
  }

  const addresses = { cashToken: (cashToken as NotoInstance).address, registryAddress, restrictedAtomFactoryAddress };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const p of PARTICIPANTS) {
    const file = bankFile(p.bankId);
    fs.writeFileSync(file, JSON.stringify(buildBankConfig(p, addresses, groupIds), null, 2));
    logger.log(`Wrote ${file}`);
    // Round-trip through the same loader the backend will actually use -- catches a
    // shape mistake here, at bootstrap time, instead of at the backend's next startup.
    // loadClientConfigFile calls validateClientConfig internally.
    loadClientConfigFile(file, { nodeUrl: nodeConnections[p.nodeIdx].clientOptions.url! });
  }

  logger.log("\nBootstrap complete.");
  return true;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
