/*
 * Option A, steps 3-4 (docs/plans/2026-10-16-option-a-bi-reporting.md): BI (bi@node1, the same node
 * as cashIssuer / bondIssuer / bondCustodian) sees every Zeto transaction. Banks (node2-4) report to
 * BI over a Pente group {bank, bi@node1}; BI's own transactions (issuance, bondCustodian's DvP leg)
 * need no report: BI verifies those from node1's own state store (BiLedger.adoptOwnStates).
 * Flow is the spike-zeto-dvp-zz.ts lifecycle on fresh V1-axis Zeto_Anon DFABI + RD tokens:
 *   I issuance (ERC20 deposit + private mint by BI; investor2 reports its deposits)
 *   T 1-unit transfer per token (investor2 reports what it sends)
 *   S1 DvP via Atom with the V1 lock lifecycle (investor2 reports its cash lock and the spend; the
 *      seller leg is BI-originated: no report)
 *   B bank-to-bank transfer investor2 -> investor3 (report only, BI cannot know otherwise)
 *   W withdraw (investor2 reports)     R rogue bank-to-bank transfer with no report
 * Reports use topic zeto-report-v1. BI uses only node1: delivered messages + its block indexer + its
 * state store (src/bi-report.ts). After each step every output of the step's txs is verified by BI.
 * Privacy: the DvP parties see states; investor4@node4 (non-party bank) holds neither reports nor
 * states, and investor3@node3 until it becomes a party in step B. U1-U4 check the verifier itself on
 * a real report; R checks unreported detection.
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
import { DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, checkDeploy, nodeConnections } from "./src/common";
import { Atom, AtomFactory, newAtomFactory } from "./src/atom";
import { BiLedger, REPORT_TOPIC, Report, buildReport, chainOutputs } from "./src/bi-report";
import { ZETO_V1, createLock, delegateLock, prepareSpend } from "./src/zeto-v1";
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
const [inv2, inv3, inv4] = ["investor2@node2", "investor3@node3", "investor4@node4"].map(party);
const bi = party("bi@node1");
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
// Deploy + setERC20 up front, each awaited. Optional on Paladin main (the v1.0.0 resume poison-pill is fixed upstream).
async function issueToken(name: string, issuer: Party): Promise<Token> {
  const zeto = await new ZetoFactory(issuer.c, "zeto").newZeto(issuer.v, { ...ZETO_V1 }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
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
// V1 leg: createLock (recipient pinned) + prepareSpendLock. The createLock tx is the "lock" Tx for reporting.
async function leg(tok: Token, owner: Party, to: Party, amount: bigint) {
  const l = await createLock(tok.zeto, owner, to, amount);
  const tx = txOf(tok, l.receipt, "createLock");
  const p = await prepareSpend(tok.zeto, owner, l.lockId);
  return { tx, lockId: l.lockId, call: p.call, states: p.states };
}

// ---- reporting ----

// Banks (node2-4) report to BI; BI-originated txs (node1 identities) need no report because BI holds those states.
async function report(p: Party, tx: Tx, known: any[] = []) {
  if (p.c === bi.c) return undefined;
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
  for (const start = Date.now(); missing().length && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) await ledger.sync();
  const parties = want.map((c) => ledger.verified.get(c)).filter(Boolean).map((v) => `${v!.output.amount} ${v!.report.token}->${ledger.ownerOf(v!.output.owner).split("@")[0]}`);
  record(`${step} BI verified every output (${txs.length} txs)`, want.length > 0 && !missing().length && !ledger.mismatches.length,
    `${want.length - missing().length}/${want.length} verified, mismatch=${ledger.mismatches.length}, duplicates merged=${ledger.duplicates}; ${parties.join(", ")}`);
}
// Non-party banks see nothing: no states, no report messages.
async function expectBlind(step: string, ...banks: Party[]) {
  for (const b of banks) {
    const schemas = await b.c.pstate.listSchemas("zeto");
    let states = 0;
    for (const t of [bond, cash]) for (const s of schemas) states += (await b.c.pstate.queryContractStates("zeto", t.zeto.address, s.id, { limit: 100 } as any, "all")).length;
    const msgs = ((await b.c.pgroup.queryMessages({ limit: 100, eq: [{ field: "topic", value: REPORT_TOPIC }] } as any)) ?? []).length;
    record(`${step} non-party bank ${b.lookup} holds no reports and no states`, states === 0 && msgs === 0, `states=${states} reports=${msgs}`);
  }
}

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== Option A steps 3-4: BI (bi@node1) reporting over the V1 Zeto_Anon lifecycle ===");
  logger.log("Deploys fresh V1 Zeto_Anon DFABI + RD (BI-owned), group {investor2, bi@node1}, then runs I U T S1 B W R.");
  if (!execute) {
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to run.");
    return;
  }

  factory = must(await newAtomFactory(cashIssuer.c, cashIssuer.v), "AtomFactory");
  const fromBlock = await bi.c.bidx.getConfirmedBlockHeight();
  bond = await issueToken("DFABI", bondIssuer);
  cash = await issueToken("RD", cashIssuer);
  logger.log(`   dfabi=${bond.zeto.address} rd=${cash.zeto.address} fromBlock=${fromBlock}`);

  // One report channel per BANK: {bank, bi@node1}. BI's own identities (node1) have none: BI holds their states.
  for (const p of [inv2, inv3]) {
    const g = must(await new PenteFactory(p.c, "pente").newPrivacyGroup({ name: `bi-report-${p.lookup.replace("@", ".")}-${Date.now()}`, members: [p.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT), "group");
    p.group = g.group.id;
    logger.log(`   group {${p.lookup}, bi@node1} = ${g.group.id}`);
  }

  // BI's onboarding knowledge: which contracts it supervises, and who each key belongs to.
  const known = [cashIssuer, bondIssuer, seller, inv2, inv3, inv4];
  const addressBook = new Map<string, string>();
  const ownerBook = new Map<string, string>();
  for (const p of known) {
    addressBook.set((await bi.c.ptx.resolveVerifier(p.lookup, "ecdsa:secp256k1", "eth_address")).toLowerCase(), p.lookup);
    ownerBook.set((await bi.c.ptx.resolveVerifier(p.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)).toLowerCase(), p.lookup);
  }
  ledger = new BiLedger(bi.c, new Map([[bond.zeto.address.toLowerCase(), "DFABI"], [cash.zeto.address.toLowerCase(), "RD"]]), addressBook, ownerBook, fromBlock);

  // I: issuance. DFABI to the BI-owned bondCustodian (node1): BI-originated, no report. RD to investor2 (bank): it reports.
  logger.log("\n== I issuance");
  const iTxs = [...(await deposits(bondIssuer, seller, bond, 2, 2000n)), ...(await deposits(cashIssuer, inv2, cash, 2, 5000n))];
  const iReports: Report[] = [];
  for (const t of iTxs) { const r = await report(t.token === bond ? seller : inv2, t); if (r) iReports.push(r); }
  await expectVerified("I", iTxs);
  await expectBlind("I", inv4);

  // U: the verifier itself, on a real (bank) report (check() does not touch the ledger).
  logger.log("\n== U verifier unit checks");
  const base = must(iReports.find((r) => r.outputs.some((o) => o.amount !== "0")), "report with value");
  const o = base.outputs.find((x) => x.amount !== "0")!;
  const otherKey = await bi.c.ptx.resolveVerifier(seller.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X);
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

  // T: 1-unit transfer per token. Seller (BI) -> investor2 is BI-originated: no report. investor2 -> seller: the bank reports.
  logger.log("\n== T private transfer");
  const tBond = txOf(bond, await bond.zeto.using(seller.c).transfer(seller.v, { transfers: [{ to: inv2.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI transfer");
  const tCash = txOf(cash, await cash.zeto.using(inv2.c).transfer(inv2.v, { transfers: [{ to: seller.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "RD transfer");
  await report(seller, tBond);
  await report(inv2, tCash);
  await expectVerified("T", [tBond, tCash]);
  await expectBlind("T", inv4);

  // S1: DvP with the V1 lock lifecycle. The seller leg (bondCustodian@node1) is BI-originated: no report.
  // The buyer (investor2, a bank) reports its cash lock and the spend.
  logger.log("\n== S1 DvP");
  const bLeg = await leg(bond, seller, inv2, BOND);
  const cLeg = await leg(cash, inv2, seller, CASH);
  const atom: Atom = must(await factory.create(cashIssuer.v, [{ contractAddress: bond.zeto.address, callData: bLeg.call }, { contractAddress: cash.zeto.address, callData: cLeg.call }]), "Atom");
  ok(await delegateLock(bond.zeto, seller, bLeg.lockId, atom.address), "DFABI delegateLock");
  ok(await delegateLock(cash.zeto, inv2, cLeg.lockId, atom.address), "RD delegateLock");
  const exec = must(ok(await atom.using(inv2.c).execute(inv2.v), "Atom execute").transactionHash, "execute txHash");
  const sBond: Tx = { token: bond, txHash: exec };
  const sCash: Tx = { token: cash, txHash: exec };
  await report(seller, bLeg.tx); // no-op (BI)
  await report(inv2, cLeg.tx);
  await sleep(5000); // let the nodes index the outputs they received
  const buyerCash = await report(inv2, sCash, cLeg.states);
  const buyerBond = await report(inv2, sBond, bLeg.states);
  logger.log(`   execute ${exec}: buyer reported ${buyerBond?.outputs.length} DFABI + ${buyerCash?.outputs.length} RD outputs (seller is BI, no report)`);
  await expectVerified("S1", [bLeg.tx, cLeg.tx, sBond, sCash]);
  await expectBlind("S1", inv4);
  // Privacy: the two DvP parties (node1, node2) see states of the swap; non-party banks (node3 before step B, node4) see none.
  const n = await Promise.all(nodes.map(async (c) => { let k = 0; for (const t of [bond, cash]) for (const sc of await c.pstate.listSchemas("zeto")) k += (await c.pstate.queryContractStates("zeto", t.zeto.address, sc.id, { limit: 100 } as any, "all")).length; return k; }));
  record("S1 the two DvP parties see states, non-party banks do not", n[0] > 0 && n[1] > 0 && n[2] === 0 && n[3] === 0, `states node1..4 = ${n.join("/")}`);

  // B: bank-to-bank transfer investor2 -> investor3. BI cannot know it without the report.
  logger.log("\n== B bank-to-bank transfer (report needed)");
  const bRd = txOf(cash, await cash.zeto.using(inv2.c).transfer(inv2.v, { transfers: [{ to: inv3.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "bank-to-bank RD transfer");
  await report(inv2, bRd);
  await expectVerified("B", [bRd]);
  await expectBlind("B", inv4);

  // W: withdraw. Seller (BI) cashes out RD, buyer redeems DFABI.
  logger.log("\n== W withdraw");
  const wCash = txOf(cash, await cash.zeto.using(seller.c).withdraw(seller.v, { amount: Number(CASH) }).waitForReceipt(LONG_POLL_TIMEOUT), "RD withdraw");
  const wBond = txOf(bond, await bond.zeto.using(inv2.c).withdraw(inv2.v, { amount: Number(BOND) }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI withdraw");
  await report(seller, wCash);
  await report(inv2, wBond);
  await expectVerified("W", [wCash, wBond]);
  await expectBlind("W", inv4);

  // Whole-chain reconciliation: every output BI's indexer saw on the two contracts is verified.
  await ledger.sync();
  const gap = ledger.unreported(0);
  record("W BI's chain scan: every output since fromBlock is verified", ledger.chain.size > 0 && gap.length === 0,
    `${ledger.chain.size} chain outputs, ${ledger.verified.size} verified (own states adopted: ${[...ledger.verified.values()].filter((v) => v.reporters.has("bi-own-state")).length}), ${gap.length} unreported`);

  // R: rogue bank-to-bank transfer (investor2 -> investor3) without a report.
  logger.log("\n== R rogue transfer (no report)");
  const rogue = txOf(cash, await cash.zeto.using(inv2.c).transfer(inv2.v, { transfers: [{ to: inv3.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "rogue transfer");
  const rogueOut = (await chainOutputs(bi.c, rogue.txHash, cash.zeto.address)).map(String);
  let flagged: ReturnType<BiLedger["unreported"]> = [];
  for (const start = Date.now(); Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) {
    await ledger.sync();
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
