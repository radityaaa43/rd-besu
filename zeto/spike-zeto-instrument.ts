/*
 * RD and DFABI instrument data on the Zeto track (spec: besu/docs/instrument-data-spec.md).
 * Builds the RD record and the DFABI record (ICMA BDT v1.2 subset) for the live tokens in
 * out/zeto-contract-data.json, has the stealth validator check them, deploys the shared
 * InstrumentRegistry through a Paladin PUBLIC tx from bondIssuer@node1, registers both (RD by
 * cashIssuer, DFABI by bondIssuer), reads them back with ptx.call and matches the hash.
 * The registry is not a Zeto contract, so a PUBLIC tx to it never hit the Paladin v1.0.0 resume
 * poison-pill (README, V0 / Paladin v1.0.0; fixed upstream on main); every receipt is still awaited. The registry artifact
 * is the stealth track's (abis/InstrumentRegistry.json, from stealth-address 8a89bc3).
 *
 * SAFE BY DEFAULT: dry-run unless --execute. The dry run needs no cluster access.
 *   npx ts-node spike-zeto-instrument.ts [--execute]
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { ethers } from "ethers";
import PaladinClient, { ITransactionReceipt, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "./src/common";
import { ZetoToken, buildDfabiRecord, buildRdRecord } from "./src/instrument";

const logger = console;
const ARTIFACT = path.join(__dirname, "abis", "InstrumentRegistry.json");
const DATA = path.join(__dirname, "out", "zeto-contract-data.json");
const SAMPLES = path.join(__dirname, "docs", "samples");

type Check = { valid: boolean; errors: string[]; hash: string; args?: { kind: string; profileVersion: string; primaryId: string; dataHash: string } };
// The shared validator and hash rule, from stealth-address/ts/instrument.ts.
const stealth = (record: unknown): Check => JSON.parse(execFileSync("node", [path.join(__dirname, "src", "stealth-check.mjs")], { input: JSON.stringify(record) }).toString());

const results: { name: string; pass: boolean }[] = [];
function record(name: string, pass: boolean, detail = "") {
  results.push({ name, pass });
  logger.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail.slice(0, 300)}` : ""}`);
}
function must<V>(v: V | undefined | null, what: string): V {
  if (v === undefined || v === null) throw new Error(`${what} missing`);
  return v;
}
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const strip = ({ _note, ...rest }: any) => rest;

function buildRecords() {
  const data = readJson(DATA);
  const tok = (k: "rd" | "dfabi"): ZetoToken => ({ address: data[k].zetoAddress, tokenName: data.tokenName });
  const rd = buildRdRecord(strip(readJson(path.join(SAMPLES, "rd-terms.sample.json"))), tok("rd"));
  const dfabiTerms = strip(readJson(path.join(SAMPLES, "dfabi-terms.sample.json")));
  const dfabi = buildDfabiRecord(dfabiTerms, tok("dfabi"));
  // A corrected series document: same ISIN and kind, so registerVersion accepts it.
  const dfabiV2 = buildDfabiRecord(
    { ...dfabiTerms, "Listing and Restrictions": { ...dfabiTerms["Listing and Restrictions"], "Documentation Name": "Fictional series documentation, corrected (test data)" } },
    tok("dfabi")
  );
  return {
    rd: { owner: "cashIssuer@node1", token: tok("rd").address, rec: rd, check: stealth(rd) },
    dfabi: { owner: "bondIssuer@node1", token: tok("dfabi").address, rec: dfabi, check: stealth(dfabi) },
    dfabiV2: { owner: "bondIssuer@node1", token: tok("dfabi").address, rec: dfabiV2, check: stealth(dfabiV2) },
  };
}

// Paladin prints bytes32 without the 0x prefix; compare hashes as lower-case 0x-prefixed hex.
const hex = (v: unknown) => { const x = String(v).toLowerCase(); return x.startsWith("0x") ? x : `0x${x}`; };

// A struct read-back may come as an object, an array or wrapped; find the named field anywhere.
function field(res: any, name: string): any {
  if (res === null || typeof res !== "object") return undefined;
  if (name in res) return res[name];
  for (const v of Object.values(res)) {
    const f = field(v, name);
    if (f !== undefined) return f;
  }
  return undefined;
}

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== Zeto instrument data: RD + DFABI (ICMA BDT v1.2 subset) ===");
  const r = buildRecords();
  for (const [name, i] of Object.entries(r)) {
    logger.log(`${name}: token=${i.token} valid=${i.check.valid} hash=${i.check.hash}${i.check.valid ? "" : ` errors=${i.check.errors.join("; ")}`}`);
    record(`${name} record passes the stealth validator`, i.check.valid, i.check.errors.join("; "));
  }
  if (results.some((x) => !x.pass)) throw new Error("a record is invalid; nothing sent");
  const haveArtifact = fs.existsSync(ARTIFACT);
  logger.log(`registry artifact abis/InstrumentRegistry.json: ${haveArtifact ? "present" : "NOT YET"}`);
  if (!execute) {
    logger.log("Plan: deploy InstrumentRegistry (PUBLIC tx, bondIssuer@node1), setRegistrar for cashIssuer + bondIssuer,");
    logger.log("      register RD (cashIssuer) and DFABI (bondIssuer), read back, match hash, one registerVersion, one NotRegistrar check.");
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to run.");
    return;
  }
  if (!haveArtifact) throw new Error("abis/InstrumentRegistry.json is missing; copy the stealth artifact first");

  const art = readJson(ARTIFACT);
  const c = new PaladinClient(nodeConnections[0].clientOptions);
  const txIds: Record<string, string> = {};
  const pub = async (client: PaladinClient, label: string, from: string, to: string | undefined, fn: string, data: unknown, extra: Record<string, unknown> = {}) => {
    const id = await client.ptx.sendTransaction({ type: TransactionType.PUBLIC, from, to, function: fn, abi: art.abi, data, ...extra } as any);
    txIds[label] = id;
    const rcpt: ITransactionReceipt | undefined = await client.pollForReceipt(id, DEFAULT_POLL_TIMEOUT);
    if (rcpt?.success !== true) throw new Error(`${label} failed: ${rcpt?.failureMessage ?? "no receipt"}`);
    return rcpt;
  };
  const call = (from: string, to: string, fn: string, data: unknown) =>
    c.ptx.call({ type: TransactionType.PUBLIC, from, to, function: fn, abi: art.abi, data } as any);
  const addr = async (lookup: string) => c.getVerifiers(lookup)[0].address();

  const deployer = "bondIssuer@node1";
  const reg = must((await pub(c, "deploy", deployer, undefined, "", {}, { bytecode: art.bytecode })).contractAddress, "registry address");
  logger.log(`registry deployed at ${reg} (tx ${txIds.deploy})`);

  for (const who of ["cashIssuer@node1", "bondIssuer@node1"]) await pub(c, `setRegistrar ${who}`, deployer, reg, "setRegistrar", { registrar: await addr(who), allowed: true });
  const isReg = await call(deployer, reg, "isRegistrar", [await addr("cashIssuer@node1")]);
  record("owner allow-listed cashIssuer and bondIssuer as registrars", field(isReg, "output") === true || isReg?.[0] === true || isReg === true, JSON.stringify(isReg));

  const regArgs = (token: string, i: { check: Check }, uri: string) => ({
    token, kind: i.check.args!.kind, profileVersion: i.check.args!.profileVersion, primaryId: i.check.args!.primaryId, dataHash: i.check.args!.dataHash, dataUri: uri,
  });
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  for (const [name, i] of [["RD", r.rd], ["DFABI", r.dfabi]] as const) {
    const uri = `https://instruments.invalid/zeto/${name.toLowerCase()}.json`; // placeholder host
    const file = path.join(__dirname, "out", `instrument-${name.toLowerCase()}.json`);
    fs.writeFileSync(file, JSON.stringify(i.rec, null, 2));
    await pub(c, `register ${name}`, i.owner, reg, "register", regArgs(i.token, i, uri));
    const back = await call(deployer, reg, "getInstrument", { token: i.token });
    const onChain = hex(field(back, "dataHash"));
    const fromFile = stealth(readJson(file)).hash;
    record(`${name} read back; on-chain dataHash == stealth recordHash of the stored JSON`, onChain === hex(fromFile) && fromFile === i.check.hash,
      `onChain=${onChain} recordHash=${fromFile} registrant=${field(back, "registrant")} version=${field(back, "version")}`);
  }

  // Versioning: a correction is a new entry; v1 stays as registered.
  await pub(c, "registerVersion DFABI", r.dfabiV2.owner, reg, "registerVersion", regArgs(r.dfabiV2.token, r.dfabiV2, "https://instruments.invalid/zeto/dfabi-v2.json"));
  const count = await call(deployer, reg, "versionCount", { token: r.dfabi.token });
  const v1 = await call(deployer, reg, "getInstrumentVersion", { token: r.dfabi.token, version: 1 });
  const v2 = await call(deployer, reg, "getInstrumentVersion", { token: r.dfabi.token, version: 2 });
  const n = field(count, "output") ?? count?.[0] ?? count;
  record("DFABI correction: versionCount 2, v1 hash unchanged, v2 hash is the new record",
    String(n) === "2" && hex(field(v1, "dataHash")) === r.dfabi.check.hash && hex(field(v2, "dataHash")) === r.dfabiV2.check.hash,
    `count=${JSON.stringify(count)} v1=${field(v1, "dataHash")} v2=${field(v2, "dataHash")}`);

  // Registrar-only: a non-registrar identity is rejected on chain.
  const c2 = new PaladinClient(nodeConnections[1].clientOptions);
  let rejected = "";
  try {
    await pub(c2, "register by non-registrar", "investor2@node2", reg, "register", regArgs(ethers.Wallet.createRandom().address, r.rd, "https://instruments.invalid/x.json"));
  } catch (e) {
    rejected = String((e as Error)?.message ?? e);
  }
  record("a non-registrar (investor2@node2) cannot register", /NotRegistrar/.test(rejected), rejected || "unexpectedly succeeded");

  logger.log(`\ntx ids: ${JSON.stringify(txIds, null, 1)}`);
  const failed = results.filter((x) => !x.pass);
  logger.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((x) => logger.log(`  FAIL ${x.name}`));
  logger.log(`Zeto instrument spike: ${failed.length ? "FAIL" : "PASS"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  logger.error("Zeto instrument spike: FAIL", err);
  process.exit(1);
});
