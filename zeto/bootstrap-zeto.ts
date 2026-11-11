/*
 * Zeto bootstrap: deploys the Zeto-based RD (cash) and DFABI (bond) tokens alongside the existing
 * Noto/Pente ones. Both are Zeto V1 `Zeto_AnonNullifier` tokens (Paladin main + PR #1189, zeto-contracts v0.5.1,
 * V1 constructor params from examples/swap), each backed by a public SampleERC20 linked with setERC20.
 * No KYC: the V0 KYC baseline (Zeto_AnonNullifierKyc) could not do DvP on Paladin v1.0.0, and the
 * platform owner is BI, so BI (node1) owns both tokens. Supply enters the private side via public ERC20
 * mint -> approve -> deposit (the ERC20 always backs it 1:1). Private `mint` by the owner is the other
 * issuance path (src/flows.ts, stress-zeto-tps.ts) and is unbacked.
 *
 * - RD: owner = cashIssuer@node1 (= BI). Each bank (node2-4) gets --initial-cash, deposited private.
 * - DFABI: owner = bondIssuer@node1 (= BI). bondCustodian@node1 (= BI, the bond seller) gets
 *   --bond-supply, deposited private.
 *
 * Zeto has no name/symbol of its own (domain sets both to tokenName), so RD vs DFABI is only
 * recorded in the output file: out/zeto-contract-data.json.
 *
 * Requires the zeto domain on all 4 nodes, installed with the Paladin main + PR #1189 image.
 *
 * IDEMPOTENT: skips if the output file exists. SAFE BY DEFAULT: dry-run unless --execute.
 * (An out/zeto-contract-data.json from the old KYC baseline blocks this script: move it away first.)
 *
 * Run from this directory (port-forwards up):
 *   npx ts-node bootstrap-zeto.ts [--execute] [--initial-cash=1000000] [--bond-supply=1000000]
 */
import * as fs from "fs";
import * as path from "path";
import PaladinClient, { PaladinVerifier, TransactionType, ZetoFactory, ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, checkDeploy, checkReceipt, nodeConnections } from "./src/common";
import { ZETO_V1 } from "./src/zeto-v1";
import erc20Artifact from "./abis/SampleERC20.json";

const logger = console;
const OUT_FILE = path.join(__dirname, "out", "zeto-contract-data.json");
const TOKEN_NAME = ZETO_V1.tokenName;

// nodeIdx indexes nodeConnections. node1 = BI (issuers + custodian), node2-4 = banks.
const IDENTITIES = [
  { lookup: "cashIssuer@node1", nodeIdx: 0 },
  { lookup: "bondIssuer@node1", nodeIdx: 0 },
  { lookup: "bondCustodian@node1", nodeIdx: 0 },
  { lookup: "investor2@node2", nodeIdx: 1 },
  { lookup: "investor3@node3", nodeIdx: 2 },
  { lookup: "investor4@node4", nodeIdx: 3 },
];

type Party = { lookup: string; client: PaladinClient; verifier: PaladinVerifier };

function parseArgs() {
  const args = process.argv.slice(2);
  const arg = (name: string, dflt: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
  return { execute: args.includes("--execute"), initialCash: arg("initial-cash", "1000000"), bondSupply: arg("bond-supply", "1000000") };
}

async function publicTx(p: Party, to: string, fn: string, data: Record<string, unknown>, abi: any[]) {
  const receipt = await p.client.pollForReceipt(
    await p.client.ptx.sendTransaction({ type: TransactionType.PUBLIC, from: p.lookup, to, function: fn, abi, data }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!checkReceipt(receipt)) throw new Error(`${fn} from ${p.lookup} failed`);
}

// Steps 1-2 of the template, for one token: deploy the V1 Zeto + ERC20, link them.
async function deployPrivateToken(owner: Party) {
  const zeto = await new ZetoFactory(owner.client, "zeto").newZeto(owner.verifier, { ...ZETO_V1 }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(zeto)) throw new Error("Zeto deploy failed");

  const erc20Receipt = await owner.client.pollForReceipt(
    await owner.client.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      from: owner.lookup,
      function: "",
      abi: erc20Artifact.abi,
      bytecode: erc20Artifact.bytecode,
      data: { initialOwner: await owner.verifier.address() },
    }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!checkReceipt(erc20Receipt) || !erc20Receipt.contractAddress) throw new Error("ERC20 deploy failed");
  const erc20 = erc20Receipt.contractAddress;

  if (!checkReceipt(await zeto!.setERC20(owner.verifier, { erc20 }).waitForReceipt(DEFAULT_POLL_TIMEOUT))) throw new Error("setERC20 failed");
  // setERC20 is a PUBLIC tx to a Zeto contract; on Paladin v1.0.0 it could crash-loop a node (V0 poison pill).
  // Fixed upstream on main, so awaiting it here is now optional but harmless.
  return { zeto: zeto!, erc20 };
}

// Template steps 3-4: public mint to holder, holder approves + deposits into the private side.
async function seed(owner: Party, holder: Party, token: { zeto: ZetoInstance; erc20: string }, amount: string) {
  await publicTx(owner, token.erc20, "mint", { to: await holder.verifier.address(), amount }, erc20Artifact.abi);
  await publicTx(holder, token.erc20, "approve", { spender: token.zeto.address, value: amount }, erc20Artifact.abi);
  const receipt = await token.zeto.using(holder.client).deposit(holder.verifier, { amount }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) throw new Error(`deposit by ${holder.lookup} failed`);
  const bal = await token.zeto.using(holder.client).balanceOf(holder.verifier, { account: holder.lookup });
  if (String(bal.totalBalance) !== amount) throw new Error(`${holder.lookup} private balance ${bal.totalBalance}, expected ${amount}`);
  logger.log(`   ${holder.lookup}: private balance ${bal.totalBalance}`);
}

async function main(): Promise<boolean> {
  const { execute, initialCash, bondSupply } = parseArgs();
  if (fs.existsSync(OUT_FILE)) {
    logger.log(`IDEMPOTENT SKIP: ${OUT_FILE} already exists. Delete it to force a fresh run.`);
    return true;
  }

  logger.log("=== Zeto bootstrap plan (template: examples/private-stablecoin) ===");
  logger.log(`  1. RD-Zeto: deploy ${TOKEN_NAME} (V1 axis: ${JSON.stringify({ ...ZETO_V1, tokenName: undefined })}) + SampleERC20 + setERC20 (owner cashIssuer@node1 = BI)`);
  logger.log(`  2. DFABI-Zeto: deploy ${TOKEN_NAME} (V1 axis) + SampleERC20 + setERC20 (owner bondIssuer@node1 = BI)`);
  logger.log(`     identities: ${IDENTITIES.map((i) => i.lookup).join(", ")}; no KYC register`);
  logger.log(`  3. RD: mint+approve+deposit ${initialCash} for each bank (node2-4)`);
  logger.log(`  4. DFABI: mint+approve+deposit ${bondSupply} for bondCustodian@node1 (BI)`);
  logger.log(`Output: ${OUT_FILE}`);
  if (!execute) {
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to deploy.");
    return true;
  }

  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const parties: Record<string, Party> = {};
  for (const i of IDENTITIES) {
    const client = clients[i.nodeIdx];
    parties[i.lookup] = { lookup: i.lookup, client, verifier: client.getVerifiers(i.lookup)[0] };
  }
  const all = Object.values(parties);
  const investors = all.filter((p) => p.lookup.startsWith("investor"));

  logger.log("1. Deploying RD-Zeto...");
  const rd = await deployPrivateToken(parties["cashIssuer@node1"]);
  logger.log(`   zeto=${rd.zeto.address} erc20=${rd.erc20}`);
  logger.log("2. Deploying DFABI-Zeto...");
  const dfabi = await deployPrivateToken(parties["bondIssuer@node1"]);
  logger.log(`   zeto=${dfabi.zeto.address} erc20=${dfabi.erc20}`);

  logger.log("3. Seeding RD to investors...");
  for (const inv of investors) await seed(parties["cashIssuer@node1"], inv, rd, initialCash);
  logger.log("4. Seeding DFABI to bondCustodian...");
  await seed(parties["bondIssuer@node1"], parties["bondCustodian@node1"], dfabi, bondSupply);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        tokenName: TOKEN_NAME,
        axis: "v1",
        rd: { zetoAddress: rd.zeto.address, erc20Address: rd.erc20, owner: "cashIssuer@node1" },
        dfabi: { zetoAddress: dfabi.zeto.address, erc20Address: dfabi.erc20, owner: "bondIssuer@node1" },
      },
      null,
      2
    )
  );
  logger.log(`Wrote ${OUT_FILE}\nZeto bootstrap complete.`);
  return true;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
