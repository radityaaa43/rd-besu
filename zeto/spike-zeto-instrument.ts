/*
 * RD and DFABI instrument data on the Zeto track (spec: besu/docs/instrument-data-spec.md).
 * Builds the RD record and the DFABI record (ICMA BDT v1.2) for the live tokens in
 * out/zeto-contract-data.json, deploys the shared InstrumentRegistry through a Paladin PUBLIC tx
 * from bondIssuer@node1, registers both, reads them back with ptx.call and recomputes the hash.
 * The registry is not a Zeto contract, so a PUBLIC tx to it cannot hit the v1.0.0 resume
 * poison-pill (README "Poison-pill bug"). No second registry contract is written here: the
 * artifact is the stealth track's, copied to abis/InstrumentRegistry.json.
 *
 * SAFE BY DEFAULT: dry-run unless --execute. The dry run needs no cluster access.
 *   npx ts-node spike-zeto-instrument.ts [--execute]
 */
import * as fs from "fs";
import * as path from "path";
import PaladinClient, { ITransactionReceipt, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "./src/common";
import { ZetoToken, buildDfabiRecord, buildRdRecord, canonicalJson, dataHash, primaryIdOf } from "./src/instrument";

const logger = console;
const ARTIFACT = path.join(__dirname, "abis", "InstrumentRegistry.json");
const DATA = path.join(__dirname, "out", "zeto-contract-data.json");
const SAMPLES = path.join(__dirname, "docs", "samples");

// ASSUMED registry interface (spec "On chain" list): confirm each name and argument order
// against the stealth artifact before --execute. The run stops if the ABI lacks any of them.
const REGISTER = { fn: "register", args: (kind: string, token: string, primaryId: string, hash: string, uri: string) => ({ token, kind, primaryId, dataHash: hash, dataUri: uri }) };
const GET = { fn: "getInstrument", args: (token: string) => ({ token }) };

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
  const dfabi = buildDfabiRecord(strip(readJson(path.join(SAMPLES, "dfabi-terms.sample.json"))), tok("dfabi"));
  return [
    { kind: "RD", name: "RD", token: rd.token.address as string, rec: rd },
    { kind: "DFABI", name: "DFABI", token: dfabi.DLTPlatformInformation["Smart Contract"] as string, rec: dfabi },
  ];
}

// A read-back is either an object with dataHash or a positional array; look for the hash in both.
const hashFrom = (res: any): string | undefined => {
  const r = Array.isArray(res) && res.length === 1 ? res[0] : res;
  if (r?.dataHash) return String(r.dataHash);
  return (Array.isArray(r) ? r : Object.values(r ?? {})).map(String).find((x: string) => /^0x[0-9a-f]{64}$/i.test(x));
};

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== Zeto instrument data: RD + DFABI (ICMA BDT v1.2) ===");
  const items = buildRecords();
  for (const i of items) logger.log(`${i.name}: token=${i.token} primaryId=${primaryIdOf(i.rec)} bytes=${canonicalJson(i.rec).length} dataHash=${dataHash(i.rec)}`);
  const haveArtifact = fs.existsSync(ARTIFACT);
  logger.log(`registry artifact abis/InstrumentRegistry.json: ${haveArtifact ? "present" : "NOT YET (waiting for the stealth track)"}`);
  if (!execute) {
    logger.log("Plan: deploy InstrumentRegistry (PUBLIC tx, bondIssuer@node1), register RD and DFABI, read back, recompute hash.");
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to run.");
    return;
  }
  if (!haveArtifact) throw new Error("abis/InstrumentRegistry.json is missing; copy the stealth artifact first");

  const art = readJson(ARTIFACT);
  for (const f of [REGISTER.fn, GET.fn]) must(art.abi.find((e: any) => e.type === "function" && e.name === f), `registry ABI function ${f}`);
  const ctor = art.abi.find((e: any) => e.type === "constructor");
  if (ctor?.inputs?.length) throw new Error(`registry constructor takes ${ctor.inputs.map((i: any) => i.name).join(", ")}: set CONSTRUCTOR_ARGS from the stealth artifact`);

  const c = new PaladinClient(nodeConnections[0].clientOptions);
  const from = "bondIssuer@node1";
  const pub = async (to: string | undefined, fn: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const id = await c.ptx.sendTransaction({ type: TransactionType.PUBLIC, from, to, function: fn, abi: art.abi, data, ...extra } as any);
    const r: ITransactionReceipt | undefined = await c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT);
    if (r?.success !== true) throw new Error(`${fn || "deploy"} failed: ${r?.failureMessage ?? "no receipt"}`);
    return r;
  };

  const registry = must((await pub(undefined, "", {}, { bytecode: art.bytecode })).contractAddress, "registry address");
  logger.log(`registry deployed at ${registry}`);
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });

  for (const i of items) {
    const hash = dataHash(i.rec);
    const uri = `https://instruments.invalid/zeto/${i.kind.toLowerCase()}.json`; // placeholder host
    fs.writeFileSync(path.join(__dirname, "out", `instrument-${i.kind.toLowerCase()}.json`), JSON.stringify(i.rec, null, 2));
    await pub(registry, REGISTER.fn, REGISTER.args(i.kind, i.token, primaryIdOf(i.rec), hash, uri));
    const back = await c.ptx.call({ type: TransactionType.PUBLIC, from, to: registry, function: GET.fn, abi: art.abi, data: GET.args(i.token) } as any);
    const onChain = hashFrom(back);
    const recomputed = dataHash(readJson(path.join(__dirname, "out", `instrument-${i.kind.toLowerCase()}.json`)));
    record(`${i.name} read back from registry; recomputed hash from the stored JSON matches`, !!onChain && onChain.toLowerCase() === recomputed.toLowerCase(), `onChain=${onChain} recomputed=${recomputed}`);
  }

  const failed = results.filter((r) => !r.pass);
  logger.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  logger.log(`Zeto instrument spike: ${failed.length ? "FAIL" : "PASS"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  logger.error("Zeto instrument spike: FAIL", err);
  process.exit(1);
});
