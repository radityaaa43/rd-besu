/*
 * Zeto bootstrap: deploys the Zeto-based RD (cash) and DFABI (bond) tokens alongside the
 * existing Noto/Pente ones. Follows Paladin's examples/private-stablecoin template exactly:
 * Zeto_AnonNullifierKyc private token + public SampleERC20, linked with setERC20; the owner
 * KYC-registers every platform identity; supply enters the private side only via public ERC20
 * mint -> approve -> deposit (never a direct Zeto mint, so the ERC20 always backs it 1:1).
 *
 * - RD-Zeto: owner = cashIssuer@node1. Each investor gets --initial-cash, deposited private.
 * - DFABI-Zeto: owner = bondIssuer@node1. bondCustodian@node1 gets --bond-supply, deposited
 *   private (same role as the Noto tranche mint).
 *
 * Zeto has no name/symbol of its own (domain sets both to tokenName), so RD vs DFABI is only
 * recorded in the output file: out/zeto-contract-data.json.
 *
 * Requires the zeto domain on all 4 nodes (applied 2026-10-15 from ~/paladin-v1 CRs).
 *
 * IDEMPOTENT: skips if the output file exists. SAFE BY DEFAULT: dry-run unless --execute.
 *
 * Run from this directory (port-forwards up):
 *   npx ts-node bootstrap-zeto.ts [--execute] [--initial-cash=1000000] [--bond-supply=1000000]
 */
import * as fs from "fs";
import * as path from "path";
import PaladinClient, {
  IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X,
  PaladinVerifier,
  TransactionType,
  ZetoFactory,
  ZetoInstance,
  algorithmZetoSnarkBJJ,
} from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, checkDeploy, checkReceipt, nodeConnections } from "./src/common";
import { buildBabyjub } from "circomlibjs";
import erc20Artifact from "./abis/SampleERC20.json";
import kycAbi from "./abis/IZetoKyc.json";

const logger = console;
const OUT_FILE = path.join(__dirname, "out", "zeto-contract-data.json");
const TOKEN_NAME = "Zeto_AnonNullifierKyc";

// Same identities as bootstrap-platform.ts; nodeIdx indexes nodeConnections.
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

// Template's getBabyjubPublicKey: the KYC registry wants the uncompressed [x, y] point.
async function getBabyjubPublicKey(verifier: PaladinVerifier): Promise<string[]> {
  const pubKeyStr = await verifier.resolve(algorithmZetoSnarkBJJ("zeto") as any, IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X as any);
  const bytes = Buffer.from(pubKeyStr.replace(/^0x/, ""), "hex");
  if (bytes.length !== 32) throw new Error(`Invalid babyjub key for ${verifier.lookup}: ${pubKeyStr}`);
  const babyJub = await buildBabyjub();
  const point = babyJub.unpackPoint(bytes);
  if (!point) throw new Error(`Failed to unpack babyjub key for ${verifier.lookup}`);
  return [babyJub.F.toString(point[0]), babyJub.F.toString(point[1])];
}

async function publicTx(p: Party, to: string, fn: string, data: Record<string, unknown>, abi: any[]) {
  const receipt = await p.client.pollForReceipt(
    await p.client.ptx.sendTransaction({ type: TransactionType.PUBLIC, from: p.lookup, to, function: fn, abi, data }),
    DEFAULT_POLL_TIMEOUT
  );
  if (!checkReceipt(receipt)) throw new Error(`${fn} from ${p.lookup} failed`);
}

// Steps 1-4 of the template, for one token: deploy Zeto + ERC20, link them, KYC everyone.
async function deployPrivateToken(owner: Party, kycParties: Party[], publicKeys: Record<string, string[]>) {
  const zeto = await new ZetoFactory(owner.client, "zeto").newZeto(owner.verifier, { tokenName: TOKEN_NAME }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
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

  for (const p of kycParties) {
    await publicTx(owner, zeto!.address, "register", { publicKey: publicKeys[p.lookup], data: "0x" }, kycAbi.abi);
  }
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
  logger.log(`  1. RD-Zeto: deploy ${TOKEN_NAME} + SampleERC20 + setERC20 + KYC register (owner cashIssuer@node1)`);
  logger.log(`  2. DFABI-Zeto: deploy ${TOKEN_NAME} + SampleERC20 + setERC20 + KYC register (owner bondIssuer@node1)`);
  logger.log(`     KYC set: ${IDENTITIES.map((i) => i.lookup).join(", ")}`);
  logger.log(`  3. RD: mint+approve+deposit ${initialCash} for each investor`);
  logger.log(`  4. DFABI: mint+approve+deposit ${bondSupply} for bondCustodian@node1`);
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

  const publicKeys: Record<string, string[]> = {};
  for (const p of all) publicKeys[p.lookup] = await getBabyjubPublicKey(p.verifier);

  logger.log("1. Deploying RD-Zeto...");
  const rd = await deployPrivateToken(parties["cashIssuer@node1"], all, publicKeys);
  logger.log(`   zeto=${rd.zeto.address} erc20=${rd.erc20}`);
  logger.log("2. Deploying DFABI-Zeto...");
  const dfabi = await deployPrivateToken(parties["bondIssuer@node1"], all, publicKeys);
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
        rd: { zetoAddress: rd.zeto.address, erc20Address: rd.erc20, owner: "cashIssuer@node1" },
        dfabi: { zetoAddress: dfabi.zeto.address, erc20Address: dfabi.erc20, owner: "bondIssuer@node1" },
        kycPublicKeys: publicKeys,
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
