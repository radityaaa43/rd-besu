/*
 * Option A, steps 3-4 (docs/plans/2026-10-16-option-a-bi-reporting.md): BI (bi@node4) sees every
 * Zeto transaction through bank reports that it verifies against the chain.
 * Flow is the spike-zeto-dvp-zz.ts lifecycle on fresh Zeto_Anon DFABI + RD tokens:
 *   I issuance (ERC20 deposit; the depositor reports)   T 1-unit transfer per token (sender reports)
 *   S1 DvP via Atom (each locker reports its lock; seller reports both legs, buyer the cash leg)
 *   W withdraw (withdrawer reports)                      R rogue transfer with no report
 * Reports travel over one Pente privacy group per bank, {bank, bi@node4}, topic zeto-report-v1.
 * BI uses only node4: delivered messages + its block indexer (src/bi-report.ts). After each step:
 * every output of the step's txs is verified by BI, and investor3@node3 holds neither reports
 * nor states. U1-U4 check the verifier itself on a real report; R checks unreported detection.
 *
 * SAFE BY DEFAULT: dry-run unless --execute. Run from this directory (port-forwards up).
 *   npx ts-node spike-zeto-bi.ts [--execute]
 */
import PaladinClient, {
  IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X,
  ITransactionReceipt,
  PaladinVerifier,
  PenteFactory,
  TransactionType,
  ZetoFactory,
  ZetoInstance,
  algorithmZetoSnarkBJJ,
} from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, checkDeploy, nodeConnections } from "./src/common";
import { Atom, AtomFactory, newAtomFactory } from "./src/atom";
import { BiLedger, REPORT_TOPIC, Report, buildReport, chainOutputs } from "./src/bi-report";
import erc20Artifact from "./abis/SampleERC20.json";

const logger = console;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOND = 100n;
const CASH = 10n;
const GRACE_MS = 20000;

type Party = { lookup: string; c: PaladinClient; v: PaladinVerifier; group?: string };
type Token = { name: string; zeto: ZetoInstance; erc20: string };
type Tx = { token: Token; txHash: string };

const nodes = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
const party = (lookup: string): Party => {
  const c = nodes[Number(lookup.split("@node")[1]) - 1];
  return { lookup, c, v: c.getVerifiers(lookup)[0] };
};
const cashIssuer = party("cashIssuer@node1");
const bondIssuer = party("bondIssuer@node1");
const seller = party("bondCustodian@node1");
const [inv2, inv3] = ["investor2@node2", "investor3@node3"].map(party);
const bi = party("bi@node4");
let factory: AtomFactory;
let bond: Token, cash: Token;
let ledger: BiLedger;

function must<V>(value: V | undefined | null, what: string): V {
  if (value === undefined || value === null) throw new Error(`${what} missing`);
  return value;
}
function ok(r: ITransactionReceipt | undefined, what: string): ITransactionReceipt {
  if (r?.success !== true) throw new Error(`${what} failed: ${r?.failureMessage ?? "no receipt"}`);
  return r;
}
const txOf = (token: Token, r: ITransactionReceipt | undefined, what: string): Tx => ({ token, txHash: must(ok(r, what).transactionHash, `${what} txHash`) });

const results: { name: string; pass: boolean }[] = [];
function record(name: string, pass: boolean, detail = "") {
  results.push({ name, pass });
  logger.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail.slice(0, 300)}` : ""}`);
}

// ---- issuance + Zeto leg helpers (same calls as spike-zeto-dvp-zz.ts) ----
// ponytail: duplicated from spike-zeto-dvp-zz.ts rather than refactoring a proven 36/36 script.

async function publicTx(p: Party, to: string, fn: string, data: Record<string, unknown>) {
  const id = await p.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, from: p.lookup, to, function: fn, abi: erc20Artifact.abi, data });
  ok(await p.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT), `${fn} from ${p.lookup}`);
}
// Deploy + setERC20 up front, each awaited (v1.0.0 resume poison-pill, README "Poison-pill bug").
async function issueToken(name: string, issuer: Party): Promise<Token> {
  const zeto = await new ZetoFactory(issuer.c, "zeto").newZeto(issuer.v, { tokenName: "Zeto_Anon" }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(zeto)) throw new Error("Zeto deploy failed");
  const id = await issuer.c.ptx.sendTransaction({
    type: TransactionType.PUBLIC, from: issuer.lookup, function: "", abi: erc20Artifact.abi, bytecode: erc20Artifact.bytecode,
    data: { initialOwner: await issuer.v.address() },
  });
  const erc20 = must((await issuer.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT))?.contractAddress, "ERC20 address");
  ok(await zeto!.setERC20(issuer.v, { erc20 }).waitForReceipt(DEFAULT_POLL_TIMEOUT), "setERC20");
  return { name, zeto: zeto!, erc20 };
}
async function deposits(issuer: Party, holder: Party, tok: Token, count: number, amount: bigint): Promise<Tx[]> {
  await publicTx(issuer, tok.erc20, "mint", { to: await holder.v.address(), amount: (amount * BigInt(count)).toString() });
  await publicTx(holder, tok.erc20, "approve", { spender: tok.zeto.address, value: (amount * BigInt(count)).toString() });
  const txs: Tx[] = [];
  for (let i = 0; i < count; i++) txs.push(txOf(tok, await tok.zeto.using(holder.c).deposit(holder.v, { amount: Number(amount) }).waitForReceipt(LONG_POLL_TIMEOUT), "deposit"));
  return txs;
}
async function lock(tok: Token, owner: Party, amount: bigint) {
  const r = await tok.zeto.using(owner.c).lock(owner.v, { amount: Number(amount), delegate: await owner.v.address() }).waitForReceipt(LONG_POLL_TIMEOUT);
  const tx = txOf(tok, r, "lock");
  let utxo: string | undefined;
  for (const start = Date.now(); !utxo && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(1000)) {
    utxo = (await owner.c.ptx.getStateReceipt(r!.id))?.confirmed?.find((s) => s.data["locked"])?.id;
  }
  return { tx, utxo: must(utxo, "locked state") };
}
async function prepare(tok: Token, owner: Party, utxo: string, to: Party, amount: bigint) {
  const txId = await tok.zeto.using(owner.c).prepareTransferLocked(owner.v, { lockedInputs: [utxo], delegate: owner.lookup, transfers: [{ to: to.v, amount: Number(amount), data: "0x" }] }).id;
  const prepared = must(await owner.c.pollForPreparedTransaction(txId, LONG_POLL_TIMEOUT), "prepared transferLocked");
  const abi = must(await owner.c.ptx.getStoredABI(prepared.transaction.abiReference ?? ""), "stored ABI").abi;
  const d = prepared.transaction.data as any;
  return { utxo, call: new ethers.Interface(abi).encodeFunctionData("transferLocked", [d.inputs, d.outputs, d.proof, d.data]), states: prepared.states.confirmed ?? [] };
}

// ---- reporting ----

async function report(p: Party, tx: Tx, known: any[] = []) {
  const r: Report = await buildReport(p.c, p.lookup, tx.token.name, tx.token.zeto.address, tx.txHash, known);
  await p.c.pgroup.sendMessage({ domain: "pente", group: must(p.group, `${p.lookup} group`), topic: REPORT_TOPIC, data: r });
  return r;
}

// BI side: wait until every output of the step's txs is verified from node4 alone.
async function expectVerified(step: string, txs: Tx[]) {
  let want: string[] = [];
  for (const t of txs) want.push(...(await chainOutputs(bi.c, t.txHash, t.token.zeto.address)).map(String));
  want = [...new Set(want)];
  const missing = () => want.filter((c) => !ledger.verified.has(c));
  for (const start = Date.now(); missing().length && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) await ledger.pollReports();
  const parties = want.map((c) => ledger.verified.get(c)).filter(Boolean).map((v) => `${v!.output.amount} ${v!.report.token}->${ledger.ownerOf(v!.output.owner).split("@")[0]}`);
  record(`${step} BI verified every output (${txs.length} txs)`, want.length > 0 && !missing().length && !ledger.mismatches.length,
    `${want.length - missing().length}/${want.length} verified, mismatch=${ledger.mismatches.length}, duplicates merged=${ledger.duplicates}; ${parties.join(", ")}`);
}
async function expectInv3Blind(step: string) {
  const schemas = await inv3.c.pstate.listSchemas("zeto");
  let states = 0;
  for (const t of [bond, cash]) for (const s of schemas) states += (await inv3.c.pstate.queryContractStates("zeto", t.zeto.address, s.id, { limit: 100 } as any, "all")).length;
  const msgs = ((await inv3.c.pgroup.queryMessages({ limit: 100, eq: [{ field: "topic", value: REPORT_TOPIC }] } as any)) ?? []).length;
  record(`${step} investor3's node3 holds no reports and no states`, states === 0 && msgs === 0, `states=${states} reports=${msgs}`);
}

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== Option A steps 3-4: BI reporting over the Zeto_Anon lifecycle ===");
  logger.log("Deploys fresh Zeto_Anon DFABI + RD, groups {bondCustodian, bi} and {investor2, bi}, then runs I U T S1 W R.");
  if (!execute) {
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to run.");
    return;
  }

  factory = must(await newAtomFactory(cashIssuer.c, cashIssuer.v), "AtomFactory");
  const fromBlock = await bi.c.bidx.getConfirmedBlockHeight();
  bond = await issueToken("DFABI", bondIssuer);
  cash = await issueToken("RD", cashIssuer);
  logger.log(`   dfabi=${bond.zeto.address} rd=${cash.zeto.address} fromBlock=${fromBlock}`);

  for (const p of [seller, inv2]) {
    const g = must(await new PenteFactory(p.c, "pente").newPrivacyGroup({ name: `bi-report-${p.lookup.replace("@", ".")}-${Date.now()}`, members: [p.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT), "group");
    p.group = g.group.id;
    logger.log(`   group {${p.lookup}, bi@node4} = ${g.group.id}`);
  }

  // BI's onboarding knowledge: which contracts it supervises, and who each key belongs to.
  const known = [cashIssuer, bondIssuer, seller, inv2, inv3];
  const addressBook = new Map<string, string>();
  const ownerBook = new Map<string, string>();
  for (const p of known) {
    addressBook.set((await bi.c.ptx.resolveVerifier(p.lookup, "ecdsa:secp256k1", "eth_address")).toLowerCase(), p.lookup);
    ownerBook.set((await bi.c.ptx.resolveVerifier(p.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)).toLowerCase(), p.lookup);
  }
  ledger = new BiLedger(bi.c, new Map([[bond.zeto.address.toLowerCase(), "DFABI"], [cash.zeto.address.toLowerCase(), "RD"]]), addressBook, ownerBook, fromBlock);

  // I: issuance. The depositor reports its deposit outputs.
  logger.log("\n== I issuance");
  const iTxs = [...(await deposits(bondIssuer, seller, bond, 2, 2000n)), ...(await deposits(cashIssuer, inv2, cash, 2, 5000n))];
  const iReports: Report[] = [];
  for (const t of iTxs) iReports.push(await report(t.token === bond ? seller : inv2, t));
  await expectVerified("I", iTxs);
  await expectInv3Blind("I");

  // U: the verifier itself, on a real report (check() does not touch the ledger).
  logger.log("\n== U verifier unit checks");
  const base = must(iReports.find((r) => r.outputs.some((o) => o.amount !== "0")), "report with value");
  const o = base.outputs.find((x) => x.amount !== "0")!;
  const otherOwner = base.reporter === seller.lookup ? inv2 : seller;
  const otherKey = await bi.c.ptx.resolveVerifier(otherOwner.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X);
  const variant = async (change: Partial<typeof o>) => (await ledger.check({ ...base, outputs: [{ ...o, ...change }] }))[0];
  for (const [name, change, want] of [
    ["U1 correct report", {}, "verified"],
    ["U2 wrong amount", { amount: (BigInt(o.amount) + 1n).toString() }, "mismatch"],
    ["U3 wrong salt", { salt: "0x" + (BigInt(o.salt) + 1n).toString(16) }, "mismatch"],
    ["U4 wrong owner", { owner: otherKey }, "mismatch"],
  ] as const) {
    const s = await variant(change);
    record(`${name} gives ${want}`, s.status === want, `${s.status}${s.reason ? ` (${s.reason})` : ""}`);
  }

  // T: 1-unit transfer per token. The sender reports.
  logger.log("\n== T private transfer");
  const tBond = txOf(bond, await bond.zeto.using(seller.c).transfer(seller.v, { transfers: [{ to: inv2.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI transfer");
  const tCash = txOf(cash, await cash.zeto.using(inv2.c).transfer(inv2.v, { transfers: [{ to: seller.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "RD transfer");
  await report(seller, tBond);
  await report(inv2, tCash);
  await expectVerified("T", [tBond, tCash]);
  await expectInv3Blind("T");

  // S1: DvP. Lockers report their locks; seller reports both legs, buyer the cash leg.
  logger.log("\n== S1 DvP");
  const bLock = await lock(bond, seller, BOND);
  const cLock = await lock(cash, inv2, CASH);
  const bLeg = await prepare(bond, seller, bLock.utxo, inv2, BOND);
  const cLeg = await prepare(cash, inv2, cLock.utxo, seller, CASH);
  const atom: Atom = must(await factory.create(cashIssuer.v, [{ contractAddress: bond.zeto.address, callData: bLeg.call }, { contractAddress: cash.zeto.address, callData: cLeg.call }]), "Atom");
  ok(await bond.zeto.using(seller.c).delegateLock(seller.v, { utxos: [bLeg.utxo], delegate: atom.address }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI delegateLock");
  ok(await cash.zeto.using(inv2.c).delegateLock(inv2.v, { utxos: [cLeg.utxo], delegate: atom.address }).waitForReceipt(LONG_POLL_TIMEOUT), "RD delegateLock");
  const exec = must(ok(await atom.using(inv2.c).execute(inv2.v), "Atom execute").transactionHash, "execute txHash");
  const sBond: Tx = { token: bond, txHash: exec };
  const sCash: Tx = { token: cash, txHash: exec };
  await report(seller, bLock.tx);
  await report(inv2, cLock.tx);
  await sleep(5000); // let the seller's node index the RD it received
  const sellerCash = await report(seller, sCash, cLeg.states);
  const sellerBond = await report(seller, sBond, bLeg.states);
  const buyerCash = await report(inv2, sCash, cLeg.states);
  logger.log(`   execute ${exec}: seller reported ${sellerBond.outputs.length} DFABI + ${sellerCash.outputs.length} RD outputs, buyer ${buyerCash.outputs.length} RD`);
  await expectVerified("S1", [bLock.tx, cLock.tx, sBond, sCash]);
  await expectInv3Blind("S1");

  // W: withdraw. Seller cashes out RD, buyer redeems DFABI.
  logger.log("\n== W withdraw");
  const wCash = txOf(cash, await cash.zeto.using(seller.c).withdraw(seller.v, { amount: Number(CASH) }).waitForReceipt(LONG_POLL_TIMEOUT), "RD withdraw");
  const wBond = txOf(bond, await bond.zeto.using(inv2.c).withdraw(inv2.v, { amount: Number(BOND) }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI withdraw");
  await report(seller, wCash);
  await report(inv2, wBond);
  await expectVerified("W", [wCash, wBond]);
  await expectInv3Blind("W");

  // Whole-chain reconciliation: every output BI's indexer saw on the two contracts is verified.
  await ledger.scanChain();
  const gap = ledger.unreported(0);
  record("W BI's chain scan: every output since fromBlock is verified", ledger.chain.size > 0 && gap.length === 0,
    `${ledger.chain.size} chain outputs, ${ledger.verified.size} verified, ${gap.length} unreported`);

  // R: rogue transfer without a report.
  logger.log("\n== R rogue transfer (no report)");
  const rogue = txOf(cash, await cash.zeto.using(inv2.c).transfer(inv2.v, { transfers: [{ to: seller.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "rogue transfer");
  const rogueOut = (await chainOutputs(bi.c, rogue.txHash, cash.zeto.address)).map(String);
  let flagged: ReturnType<BiLedger["unreported"]> = [];
  for (const start = Date.now(); Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) {
    await ledger.pollReports();
    await ledger.scanChain();
    flagged = ledger.unreported(GRACE_MS);
    if (flagged.length >= rogueOut.length) break;
  }
  const flaggedIds = flagged.map((f) => f.commitment).sort().join(",");
  record(`R rogue outputs flagged unreported after ${GRACE_MS / 1000}s grace`, rogueOut.length > 0 && flaggedIds === [...rogueOut].sort().join(","),
    `${flagged.length} flagged, rogue tx has ${rogueOut.length} outputs (${rogue.txHash})`);
  record("R unreported outputs attributed to investor2@node2", flagged.length > 0 && flagged.every((f) => f.sender === inv2.lookup),
    flagged.map((f) => `${f.token} ${f.txHash.slice(0, 10)} sender=${f.sender} (signer ${f.from.slice(0, 10)}, one-time key)`).join("; "));
  record("R no mismatch anywhere", ledger.mismatches.length === 0, `mismatch=${ledger.mismatches.length}`);
  logger.log(`\nBI totals: verified=${ledger.verified.size} mismatch=${ledger.mismatches.length} unreported=${flagged.length} duplicates merged=${ledger.duplicates}`);

  const failed = results.filter((r) => !r.pass);
  logger.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((r) => logger.log(`  FAIL ${r.name}`));
  logger.log(`BI reporting spike: ${failed.length ? "FAIL" : "PASS"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  logger.error("BI reporting spike: FAIL", err);
  process.exit(1);
});
