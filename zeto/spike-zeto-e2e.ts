/*
 * End-to-end test of every Zeto feature for RD and DFABI on the live Paladin cluster: a HAPPY and
 * NEGATIVE path per feature, each negative asserting the exact Paladin error code or revert name.
 * Zeto_Anon on the V1 axis (Paladin main + PR #1189, zeto-contracts v0.5.1), no Noto, no KYC; fresh
 * tokens per group. Topology: node1 = BI (cashIssuer, bondIssuer, bondCustodian, bi), node2-4 = banks.
 *
 * Groups (--only=a,b runs a subset; no --only runs everything and writes the report):
 *   life  RD + DFABI lifecycle on one token pair: deposit, mint, transfer, S1 DvP, privacy, withdraw
 *   bi    Option A BI reporting over the life flow (implies life): banks report, BI-originated txs are
 *         verified from node1's own state store, U1-U6, rogue bank-to-bank transfer flagged
 *   reg   InstrumentRegistry on Paladin + the shared record validator (implies life)
 *   dvp   Atom: undelegated leg, replay, double-spend, mismatched legs, terms not bound (finding)
 *   neg   tampered legs, third-party delegate, cancelLock, over-lock, locked-state transfer, foreign lock
 *   f1b   cancelLock after prepareSpendLock (V0 finding re-check)    f2  Atom.cancel() after delegation (finding)
 *   kyc   smoke-zeto.ts on the bootstrap tokens (group name kept; the tokens are Zeto_Anon V1 now)
 * Skipped by design: BI offline (node1 restart, needs user approval; see spike-zeto-bi-offline.ts).
 * Phase 0 deploys + links (setERC20) every token set, each awaited, before anything else: on Paladin
 * main the PUBLIC-tx poison pill is fixed, so that up-front phase is now OPTIONAL (kept as is).
 * Cluster safety: after every group, kubectl (read-only) must show no pod restart / non-Running.
 *
 * SAFE BY DEFAULT: dry-run unless --execute. The dry run runs the offline validator cases only.
 *   npx ts-node spike-zeto-e2e.ts [--execute] [--only=life,bi,...]
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
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
import { heldStates } from "./src/flows";
import { SpendLeg, ZETO_V1, cancelLock, createLock, delegateLock, prepareSpend, tamperedCall } from "./src/zeto-v1";
import { buildDfabiRecord, buildRdRecord, catalogField } from "./src/instrument";
import atomJson from "./abis/Atom.json";
import erc20Artifact from "./abis/SampleERC20.json";
import registryArtifact from "./abis/InstrumentRegistry.json";

const logger = console;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOND = 100n;
const CASH = 10n;
const GRACE_MS = 20000;
const KUBECONFIG = "/home/ecs-user/alibaba-kube/alibaba-zeto.yaml";
// The v1.0.0 (V0) report docs/e2e-report-2026-10-17.md is kept as history; the V1 run writes its own file.
const REPORT_FILE = path.join(__dirname, "docs", "e2e-report-v1.md");

type Party = { lookup: string; c: PaladinClient; v: PaladinVerifier };
type Tok = "DFABI" | "RD";
type Pair = { bond: ZetoInstance; cash: ZetoInstance; bondErc20: string; cashErc20: string };
type Snap = Map<Party, { bond: bigint; cash: bigint }>;
type Leg = SpendLeg & { lockRcpt: ITransactionReceipt };
type Rcpt = ITransactionReceipt | undefined;

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
let T: Pair;
let life: Pair | undefined;

const must = <V>(v: V | undefined | null, what: string): V => {
  if (v === undefined || v === null) throw new Error(`${what} missing`);
  return v;
};
const ok = (r: Rcpt, what: string): ITransactionReceipt => {
  if (r?.success !== true) throw new Error(`${what} failed: ${r?.failureMessage ?? (r ? `receipt without success: ${JSON.stringify(r).slice(0, 300)}` : "no receipt (timeout)")}`);
  return r;
};
const msgOf = (e: unknown) => String((e as Error)?.message ?? e);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const hex = (v: unknown) => { const x = String(v).toLowerCase(); return x.startsWith("0x") ? x : `0x${x}`; };

// ---- result matrix: one line per case ----

type Row = { id: string; feature: string; kind: "happy" | "negative" | "finding"; expected: string; actual: string; status: "PASS" | "FAIL" | "FINDING" | "BLOCKED"; tx: string };
const rows: Row[] = [];
function rec(id: string, feature: string, kind: Row["kind"], expected: string, actual: string, pass: boolean, tx = "-") {
  const row: Row = { id, feature, kind, expected, actual: actual.replace(/\s+/g, " ").slice(0, 400), status: kind === "finding" ? "FINDING" : pass ? "PASS" : "FAIL", tx };
  if (kind === "finding" && !pass) row.status = "FAIL"; // a finding whose documented behaviour changed needs a look
  rows.push(row);
  logger.log(`${row.id} | ${row.feature} | ${row.kind} | ${row.expected} | ${row.actual.slice(0, 220)} | ${row.status} | ${row.tx}`);
}
const happy = (id: string, feature: string, expected: string, actual: string, pass: boolean, tx = "-") => rec(id, feature, "happy", expected, actual, pass, tx);

// A negative over a domain/public tx: must fail, and the failure must match `expect` (code or revert name).
async function negTx(id: string, feature: string, expect: RegExp, send: () => Promise<Rcpt>, kind: "negative" | "finding" = "negative") {
  let why: string | undefined;
  let tx = "-";
  try {
    const r = await send();
    tx = r?.id ?? "-";
    if (r?.success !== true) why = r?.failureMessage ?? "no receipt";
  } catch (e) {
    why = msgOf(e);
  }
  rec(id, feature, kind, `fail ${expect.source}`, why ?? "unexpectedly succeeded", why !== undefined && expect.test(why), tx);
}
// A negative over a ptx.call / validator: must throw (or return an error list) matching `expect`.
async function negCall(id: string, feature: string, expect: RegExp, send: () => Promise<unknown>) {
  let why: string | undefined;
  try {
    await send();
  } catch (e) {
    why = msgOf(e);
  }
  rec(id, feature, "negative", `fail ${expect.source}`, why ?? "unexpectedly succeeded", why !== undefined && expect.test(why));
}

// ---- cluster safety: read-only kubectl, no restart allowed ----

const podState = () =>
  execFileSync("kubectl", ["--kubeconfig", KUBECONFIG, "-n", "paladin", "get", "pods", "-o", "jsonpath={range .items[*]}{.metadata.name} {.status.phase} {.status.containerStatuses[*].restartCount}{\"\\n\"}{end}"], { timeout: 30000 })
    .toString().split("\n").filter((l) => l.startsWith("paladin-node")).sort().join("\n");
let podBaseline = "";
function podsStillHealthy(where: string) {
  let now: string;
  try { now = podState(); } catch (e) { logger.log(`   (pod check skipped after ${where}: ${msgOf(e).slice(0, 80)})`); return; }
  if (now !== podBaseline) throw new Error(`STOP: Paladin pods changed after ${where}\nbefore:\n${podBaseline}\nnow:\n${now}`);
  logger.log(`   pods ok after ${where}`);
}

// ---- issuance + balances (same calls as spike-zeto-dvp-zz.ts) ----
// ponytail: these helpers repeat the proven spike's (spike-zeto-dvp-zz.ts / spike-zeto-bi.ts are
// scripts that run on import); upgrade path is a shared src/zeto-flow.ts once the spikes are refactored.

async function publicTx(p: Party, to: string, fn: string, data: Record<string, unknown>) {
  const id = await p.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, from: p.lookup, to, function: fn, abi: erc20Artifact.abi, data });
  ok(await p.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT), `${fn} from ${p.lookup}`);
}
const erc20Balance = async (erc20: string, account: string) =>
  BigInt((await cashIssuer.c.ptx.call({ type: TransactionType.PUBLIC, abi: erc20Artifact.abi, function: "balanceOf", to: erc20, from: cashIssuer.lookup, data: { account } }))[0]);

async function issueToken(issuer: Party) {
  const zeto = await new ZetoFactory(issuer.c, "zeto").newZeto(issuer.v, { ...ZETO_V1 }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(zeto)) throw new Error("Zeto deploy failed");
  const id = await issuer.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, from: issuer.lookup, function: "", abi: erc20Artifact.abi, bytecode: erc20Artifact.bytecode, data: { initialOwner: await issuer.v.address() } });
  const erc20 = must((await issuer.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT))?.contractAddress, "ERC20 address");
  ok(await zeto!.setERC20(issuer.v, { erc20 }).waitForReceipt(DEFAULT_POLL_TIMEOUT), "setERC20");
  return { zeto: zeto!, erc20 };
}
const issued: { bond: { zeto: ZetoInstance; erc20: string }; cash: { zeto: ZetoInstance; erc20: string } }[] = [];
async function issueAll(n: number) {
  for (let i = 0; i < n; i++) issued.push({ bond: await issueToken(bondIssuer), cash: await issueToken(cashIssuer) });
}
// One deposit per UTXO wanted; returns the deposit receipts.
async function seed(issuer: Party, holder: Party, zeto: ZetoInstance, erc20: string, count: number, amount: bigint) {
  await publicTx(issuer, erc20, "mint", { to: await holder.v.address(), amount: (amount * BigInt(count)).toString() });
  await publicTx(holder, erc20, "approve", { spender: zeto.address, value: (amount * BigInt(count)).toString() });
  const out: ITransactionReceipt[] = [];
  for (let i = 0; i < count; i++) out.push(ok(await zeto.using(holder.c).deposit(holder.v, { amount: Number(amount) }).waitForReceipt(LONG_POLL_TIMEOUT), `deposit by ${holder.lookup}`));
  return out;
}
async function freshTokens(buyers: Party[], sellerUtxos = 5, buyerUtxos = 2) {
  const { bond, cash } = must(issued.shift(), "pre-issued token set");
  T = { bond: bond.zeto, cash: cash.zeto, bondErc20: bond.erc20, cashErc20: cash.erc20 };
  logger.log(`   tokens dfabi=${bond.zeto.address} (erc20 ${bond.erc20}) rd=${cash.zeto.address} (erc20 ${cash.erc20})`);
  const [sd, ...bd] = await Promise.all([seed(bondIssuer, seller, bond.zeto, bond.erc20, sellerUtxos, 2000n), ...buyers.map((b) => seed(cashIssuer, b, cash.zeto, cash.erc20, buyerUtxos, 5000n))]);
  return { sellerDeposits: sd, buyerDeposits: bd };
}

async function snap(...ps: Party[]): Promise<Snap> {
  return new Map(await Promise.all(ps.map(async (p) => {
    const [b, c] = await Promise.all([T.bond.using(p.c).balanceOf(p.v, { account: p.lookup }), T.cash.using(p.c).balanceOf(p.v, { account: p.lookup })]);
    return [p, { bond: BigInt(b.totalBalance), cash: BigInt(c.totalBalance) }] as const;
  })));
}
const fmt = (s: Snap) => [...s].map(([p, b]) => `${p.lookup}=${b.bond}/${b.cash}`).join(" ");
function shift(s: Snap, deltas: [Party, bigint, bigint][]): Snap {
  const out: Snap = new Map([...s].map(([p, b]) => [p, { ...b }]));
  for (const [p, bond, cash] of deltas) { const b = must(out.get(p), p.lookup); b.bond += bond; b.cash += cash; }
  return out;
}
// Balances lag receipts: poll until they match.
async function expectBalances(id: string, feature: string, expected: string, want: Snap, tx = "-") {
  let got = await snap(...want.keys());
  for (const start = Date.now(); fmt(got) !== fmt(want) && Date.now() - start < LONG_POLL_TIMEOUT; got = await snap(...want.keys())) await sleep(2000);
  happy(id, feature, expected, fmt(got) === fmt(want) ? fmt(got) : `got ${fmt(got)}, want ${fmt(want)}`, fmt(got) === fmt(want), tx);
}
// After a failed tx: give any stray effect time to land, then require no change at all.
async function expectUnchanged(id: string, feature: string, before: Snap) {
  await sleep(5000);
  const got = await snap(...before.keys());
  happy(id, feature, "balances unchanged", fmt(got), fmt(got) === fmt(before));
}

// ---- Zeto V1 lock lifecycle / Atom (examples/swap, both tokens) ----

// A leg = createLock (recipient pinned) + prepareSpendLock. `amount` is what the lock pays out.
async function legOf(zeto: ZetoInstance, owner: Party, to: Party, amount: bigint): Promise<Leg> {
  const l = await createLock(zeto, owner, to, amount);
  return { ...(await prepareSpend(zeto, owner, l.lockId)), lockRcpt: l.receipt };
}
const bondLeg = (to: Party, from: Party = seller) => legOf(T.bond, from, to, BOND);
const cashLeg = (buyer: Party, to: Party = seller, amount: bigint = CASH) => legOf(T.cash, buyer, to, amount);
const delegate = (zeto: ZetoInstance, p: Party, lockId: string, to: string) => delegateLock(zeto, p, lockId, to);
// V1 reclaim = cancelLock: only the current lock spender may; the pre-pinned cancel output returns the funds.
const reclaim = (zeto: ZetoInstance, owner: Party, lockId: string) => cancelLock(zeto, owner, lockId);
const tampered = tamperedCall;
const createAtom = async (ops: [string, string][]) => must(await factory.create(cashIssuer.v, ops.map(([contractAddress, callData]) => ({ contractAddress, callData }))), "Atom");
const stdAtom = (bond: Leg, cash: Leg) => createAtom([[T.bond.address, bond.call], [T.cash.address, cash.call]]);
async function cancelAtom(atom: Atom, by: Party) {
  const id = await by.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, abi: atomJson.abi, function: "cancel", from: by.lookup, to: atom.address, data: {} });
  return by.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT);
}
async function delegateBoth(bond: Leg, cash: Leg, buyer: Party, atom: Atom) {
  ok(await delegate(T.bond, seller, bond.lockId, atom.address), "DFABI delegateLock");
  ok(await delegate(T.cash, buyer, cash.lockId, atom.address), "RD delegateLock");
}
async function swap(buyer: Party) {
  const bond = await bondLeg(buyer);
  const cash = await cashLeg(buyer);
  const atom = await stdAtom(bond, cash);
  await delegateBoth(bond, cash, buyer, atom);
  const exec = ok(await atom.using(buyer.c).execute(buyer.v), "Atom execute");
  return { atom, exec, bond, cash };
}
async function visibleStates(c: PaladinClient, address: string) {
  let n = 0;
  for (const s of await c.pstate.listSchemas("zeto")) n += (await c.pstate.queryContractStates("zeto", address, s.id, { limit: 1000 } as any, "all")).length;
  return n;
}
const transferOf = (p: Party, zeto: ZetoInstance, to: Party, amount: number) => zeto.using(p.c).transfer(p.v, { transfers: [{ to: to.v, amount, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT);

// ---- BI reporting (Option A), state shared across the life flow ----

let ledger: BiLedger | undefined;
const groupOf = new Map<Party, string>();
const tokenName = (t: Tok) => (t === "DFABI" ? "DFABI" : "RD");
const zetoOf = (t: Tok) => (t === "DFABI" ? T.bond : T.cash);
async function biSetup(fromBlock: number) {
  // Option A: every BANK (node2-4) has a group {bank, bi@node1}. BI's own identities (node1) need none.
  for (const p of [inv2]) {
    const g = must(await new PenteFactory(p.c, "pente").newPrivacyGroup({ name: `e2e-report-${p.lookup.replace("@", ".")}-${Date.now()}`, members: [p.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT), "group");
    groupOf.set(p, g.group.id);
    logger.log(`   group {${p.lookup}, bi@node1} = ${g.group.id}`);
  }
  const addressBook = new Map<string, string>();
  const ownerBook = new Map<string, string>();
  for (const p of [cashIssuer, bondIssuer, seller, inv2, inv3, inv4]) {
    addressBook.set((await bi.c.ptx.resolveVerifier(p.lookup, "ecdsa:secp256k1", "eth_address")).toLowerCase(), p.lookup);
    ownerBook.set((await bi.c.ptx.resolveVerifier(p.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)).toLowerCase(), p.lookup);
  }
  ledger = new BiLedger(bi.c, new Map([[T.bond.address.toLowerCase(), "DFABI"], [T.cash.address.toLowerCase(), "RD"]]), addressBook, ownerBook, fromBlock);
}
async function report(p: Party, t: Tok, r: Rcpt, known: any[] = []): Promise<Report | undefined> {
  if (!ledger || p.c === bi.c) return undefined; // BI-originated (node1): BI already holds those states, no report
  const rep = await buildReport(p.c, p.lookup, tokenName(t), zetoOf(t).address, must(r?.transactionHash, "txHash"), known);
  await p.c.pgroup.sendMessage({ domain: "pente", group: must(groupOf.get(p), `${p.lookup} group`), topic: REPORT_TOPIC, data: rep });
  return rep;
}
// BI side: every output of the step's txs must be verified from node1 alone (bank reports + BI's own states).
async function biVerify(id: string, step: string, txs: { t: Tok; r: Rcpt }[]) {
  const L = ledger;
  if (!L) return;
  let want: string[] = [];
  for (const x of txs) want.push(...(await chainOutputs(bi.c, must(x.r?.transactionHash, "txHash"), zetoOf(x.t).address)).map(String));
  want = [...new Set(want)];
  const missing = () => want.filter((c) => !L.verified.has(c));
  for (const start = Date.now(); missing().length && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) await L.sync();
  happy(id, "Option A BI reporting", `${step}: every output verified, 0 mismatch`, `${want.length - missing().length}/${want.length} verified, mismatch=${L.mismatches.length}, duplicates merged=${L.duplicates}`, want.length > 0 && !missing().length && !L.mismatches.length, txs[0].r?.id);
}

// ================= groups =================

async function groupLife(withBi: boolean) {
  logger.log("\n== life: RD + DFABI lifecycle");
  const fromBlock = await bi.c.bidx.getConfirmedBlockHeight();
  const dep = await freshTokens([inv2], 2, 2);
  life = { bond: T.bond, cash: T.cash, bondErc20: T.bondErc20, cashErc20: T.cashErc20 };
  if (withBi) await biSetup(fromBlock);
  let s = await snap(seller, inv2);

  // L1 / L2 issuance: ERC20 mint -> approve -> deposit
  for (const [id, name, holder, zeto, erc20, priv, want] of [
    ["L1", "RD issuance (deposit) by cashIssuer", inv2, T.cash, T.cashErc20, must(s.get(inv2), "inv2").cash, 10000n],
    ["L2", "DFABI issuance (deposit) by bondIssuer", seller, T.bond, T.bondErc20, must(s.get(seller), "seller").bond, 4000n],
  ] as const) {
    const [pub, escrow] = await Promise.all([erc20Balance(erc20, await holder.v.address()), erc20Balance(erc20, zeto.address)]);
    happy(id, name, `private ${want}, public 0, Zeto escrow ${want}`, `private=${priv} public=${pub} escrow=${escrow}`, priv === want && pub === 0n && escrow === want, dep.buyerDeposits[0]?.[0]?.id);
  }
  const dTxs = [...dep.sellerDeposits.map((r) => ({ t: "DFABI" as Tok, r })), ...dep.buyerDeposits[0].map((r) => ({ t: "RD" as Tok, r }))];
  const dReports: Report[] = [];
  // Deposits to bondCustodian (node1 = BI) need no report; the bank (investor2) reports its RD deposits.
  for (const x of dTxs) { const r = await report(x.t === "DFABI" ? seller : inv2, x.t, x.r); if (r) dReports.push(r); }

  // L3 / L4 mint by the token's deployer (unbacked by ERC20)
  s = await snap(seller, inv2);
  const mRd = ok(await T.cash.using(cashIssuer.c).mint(cashIssuer.v, { mints: [{ to: inv2.v, amount: 7, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "RD mint");
  await expectBalances("L3", "RD mint by cashIssuer", "investor2 +7 RD", shift(s, [[inv2, 0n, 7n]]), mRd.id);
  const mBond = ok(await T.bond.using(bondIssuer.c).mint(bondIssuer.v, { mints: [{ to: seller.v, amount: 5, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI mint");
  await expectBalances("L4", "DFABI mint by bondIssuer", "bondCustodian +5 DFABI", shift(s, [[seller, 5n, 0n], [inv2, 0n, 7n]]), mBond.id);
  await report(inv2, "RD", mRd); // BI-issued mint: BI holds the state already, the bank reports anyway (merged as a duplicate)
  await report(seller, "DFABI", mBond); // no-op: bondCustodian is on node1 (BI)
  s = await snap(seller, inv2);
  // N-L1/N-L2 mint by someone who is not the token deployer: the on-chain minter check rejects it
  await negTx("L5", "RD mint by non-issuer (bondIssuer)", /PD012216.*reverted/, () => T.cash.using(bondIssuer.c).mint(bondIssuer.v, { mints: [{ to: inv2.v, amount: 1000, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT));
  await negTx("L6", "DFABI mint by non-issuer (cashIssuer)", /PD012216.*reverted/, () => T.bond.using(cashIssuer.c).mint(cashIssuer.v, { mints: [{ to: seller.v, amount: 1000, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT));
  await expectUnchanged("L7", "non-issuer mints created nothing", s);
  await biVerify("B1", "deposit + mint", [...dTxs, { t: "RD", r: mRd }, { t: "DFABI", r: mBond }]);

  // L8 / L9 private transfer
  s = await snap(seller, inv2);
  const tBond = ok(await transferOf(seller, T.bond, inv2, 1), "DFABI transfer");
  await expectBalances("L8", "DFABI transfer bondCustodian -> investor2", "-1 / +1", shift(s, [[seller, -1n, 0n], [inv2, 1n, 0n]]), tBond.id);
  s = await snap(seller, inv2);
  const tCash = ok(await transferOf(inv2, T.cash, seller, 1), "RD transfer");
  await expectBalances("L9", "RD transfer investor2 -> bondCustodian", "-1 / +1", shift(s, [[seller, 0n, 1n], [inv2, 0n, -1n]]), tCash.id);
  await report(seller, "DFABI", tBond);
  await report(inv2, "RD", tCash);
  await biVerify("B2", "transfer", [{ t: "DFABI", r: tBond }, { t: "RD", r: tCash }]);

  // transfer negatives (domain assemble errors, no chain footprint)
  s = await snap(seller, inv2);
  const sb = must(s.get(seller), "seller").bond;
  const ic = must(s.get(inv2), "inv2").cash;
  await negTx("L10", "DFABI transfer more than balance", new RegExp(`PD210033.*Insufficient funds \\(available=${sb}\\)`), () => transferOf(seller, T.bond, inv2, Number(sb) + 1));
  await negTx("L11", "RD transfer more than balance", new RegExp(`PD210033.*Insufficient funds \\(available=${ic}\\)`), () => transferOf(inv2, T.cash, seller, Number(ic) + 1));
  await negTx("L12", "transfer of amount 0", /PD210027.*must be in the range \(0, 2\^100\)/, () => transferOf(seller, T.bond, inv2, 0));
  await negTx("L13", "transfer with no recipients", /PD210024.*No transfer parameters provided/, () => T.bond.using(seller.c).transfer(seller.v, { transfers: [] }).waitForReceipt(LONG_POLL_TIMEOUT));
  await negTx("L14", "holder without balance (investor3) transfers", /PD210033.*Insufficient funds \(available=0\)/, () => transferOf(inv3, T.cash, inv2, 1));
  await expectUnchanged("L15", "failed transfers moved nothing", s);

  // S1 DvP through an Atom, on the life tokens so BI can verify the whole chain
  s = await snap(seller, inv2);
  const bLeg = await bondLeg(inv2);
  const cLeg = await cashLeg(inv2);
  const atom = await stdAtom(bLeg, cLeg);
  await delegateBoth(bLeg, cLeg, inv2, atom);
  const exec = ok(await atom.using(inv2.c).execute(inv2.v), "Atom execute");
  await expectBalances("S1", "DvP Zeto-vs-Zeto: lock both, prepare, execute atomically", `bondCustodian -${BOND} DFABI +${CASH} RD, investor2 reverse`, shift(s, [[seller, -BOND, CASH], [inv2, BOND, -CASH]]), exec.id);
  // Seller = BI (node1): its lock and its legs are in BI's own state store, no report. The bank reports its cash lock and the spend.
  await report(inv2, "RD", cLeg.lockRcpt);
  await sleep(5000);
  await report(inv2, "RD", exec, cLeg.states);
  await biVerify("B3", "DvP locks + execute", [{ t: "DFABI", r: bLeg.lockRcpt }, { t: "RD", r: cLeg.lockRcpt }, { t: "DFABI", r: exec }, { t: "RD", r: exec }]);

  // P privacy
  for (const [id, name, address] of [["P1", "DFABI", T.bond.address], ["P2", "RD", T.cash.address]]) {
    const n = await Promise.all(nodes.map((c) => visibleStates(c, address)));
    happy(id, `Privacy: ${name} states visible per node`, "the two DvP parties node1+node2 >0, non-party banks node3 = node4 = 0", `node1..4 = ${n.join("/")}`, n[0] > 0 && n[1] > 0 && n[2] === 0 && n[3] === 0);
  }
  const foreign = await inv3.c.pstate.queryContractStates("zeto", T.cash.address, (await inv3.c.pstate.listSchemas("zeto"))[0].id, { limit: 10 } as any, "all");
  const bal3 = await T.cash.using(inv3.c).balanceOf(inv3.v, { account: seller.lookup });
  happy("P3", "Privacy: investor3 reads bondCustodian's RD balance", "0 balance, 0 states", `totalBalance=${bal3.totalBalance} states=${foreign.length}`, bal3.totalBalance === "0" && foreign.length === 0);

  // W withdraw / redeem
  for (const [id, name, p, zeto, erc20, amount, t] of [
    ["W1", "RD withdraw (cash-out) by bondCustodian", seller, T.cash, T.cashErc20, CASH, "RD"],
    ["W2", "DFABI withdraw (redeem) by investor2", inv2, T.bond, T.bondErc20, BOND, "DFABI"],
  ] as const) {
    const addr = await p.v.address();
    const read = async () => {
      const [priv, pub, escrow] = await Promise.all([zeto.using(p.c).balanceOf(p.v, { account: p.lookup }), erc20Balance(erc20, addr), erc20Balance(erc20, zeto.address)]);
      return `private=${priv.totalBalance} public=${pub} escrow=${escrow}`;
    };
    const [priv0, pub0, esc0] = (await read()).match(/\d+/g)!.map(BigInt);
    const want = `private=${priv0 - amount} public=${pub0 + amount} escrow=${esc0 - amount}`;
    const w = ok(await zeto.using(p.c).withdraw(p.v, { amount: Number(amount) }).waitForReceipt(LONG_POLL_TIMEOUT), `${name}`);
    let got = await read();
    for (const start = Date.now(); got !== want && Date.now() - start < LONG_POLL_TIMEOUT; got = await read()) await sleep(2000);
    happy(id, name, want, got, got === want, w.id);
    await report(p, t, w);
    await biVerify(`B${id}`, `withdraw ${t}`, [{ t, r: w }]);
  }
  await negTx("W3", "withdraw by a holder without balance (investor3)", /PD210033.*Insufficient funds \(available=0\)/, () => T.cash.using(inv3.c).withdraw(inv3.v, { amount: 1 }).waitForReceipt(LONG_POLL_TIMEOUT));
  await negTx("W4", "withdraw more than private balance (investor2 RD)", /PD210033.*Insufficient funds/, () => T.cash.using(inv2.c).withdraw(inv2.v, { amount: 1_000_000 }).waitForReceipt(LONG_POLL_TIMEOUT));

  if (withBi) await groupBi(dReports, tBond);
}

async function groupBi(dReports: Report[], tBond: ITransactionReceipt) {
  const L = must(ledger, "ledger");
  logger.log("\n== bi: verifier unit checks + inv3 blind + rogue");
  const base = must(dReports.find((r) => r.token === "RD" && r.outputs.some((o) => o.amount !== "0")), "RD deposit report (bank report)");
  const o = base.outputs.find((x) => x.amount !== "0")!;
  // base is investor2's RD deposit, so the "wrong" owner must be another identity's key.
  const otherKey = await bi.c.ptx.resolveVerifier(seller.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X);
  const variant = async (change: Partial<typeof o>, top: Partial<Report> = {}) => (await L.check({ ...base, ...top, outputs: [{ ...o, ...change }] }))[0];
  const cases: [string, string, Partial<typeof o>, Partial<Report>, string, string | undefined][] = [
    ["U1", "BI: correct report", {}, {}, "verified", undefined],
    ["U2", "BI: report with wrong amount", { amount: (BigInt(o.amount) + 1n).toString() }, {}, "mismatch", "recomputed commitment differs"],
    ["U3", "BI: report with wrong salt", { salt: "0x" + (BigInt(o.salt) + 1n).toString(16) }, {}, "mismatch", "recomputed commitment differs"],
    ["U4", "BI: report with wrong owner", { owner: otherKey }, {}, "mismatch", "recomputed commitment differs"],
    ["U5", "BI: report naming another tx than the one that created the output", {}, { txHash: must(tBond.transactionHash, "transfer hash") }, "mismatch", `not an output of ${tBond.transactionHash} on ${base.contract}`],
  ];
  for (const [id, name, change, top, want, reason] of cases) {
    const st = await variant(change, top);
    const pass = st.status === want && (reason === undefined ? st.reason === undefined : st.reason === reason);
    rec(id, name, want === "verified" ? "happy" : "negative", `${want}${reason ? ` (${reason})` : ""}`, `${st.status}${st.reason ? ` (${st.reason})` : ""}`, pass);
  }
  const [v0, m0] = [L.verified.size, L.mismatches.length];
  await L.ingest({ ...base, contract: ethers.Wallet.createRandom().address });
  rec("U6", "BI: report for a contract BI does not supervise", "negative", "ignored: no verified, no mismatch added", `verified +${L.verified.size - v0}, mismatch +${L.mismatches.length - m0}`, L.verified.size === v0 && L.mismatches.length === m0);

  // inv3 blind: no report messages of this run's groups (node3 keeps its own reports from earlier runs, e.g. spike-zeto-bi.ts)
  let msgs = 0;
  for (const g of groupOf.values()) msgs += ((await inv3.c.pgroup.queryMessages({ limit: 100, eq: [{ field: "topic", value: REPORT_TOPIC }, { field: "group", value: g }] } as any)) ?? []).length;
  happy("B4", "Privacy: investor3@node3 holds no BI reports of this run", "0 report messages", `reports=${msgs}`, msgs === 0);

  // whole-chain reconciliation, then a rogue (unreported) transfer
  await L.sync();
  const gap = L.unreported(0);
  happy("B5", "Option A BI reporting", "BI chain scan: every output on the supervised tokens is verified", `chain=${L.chain.size} verified=${L.verified.size} unreported=${gap.length}`, L.chain.size > 0 && gap.length === 0);
  const rogue = ok(await transferOf(inv2, T.cash, inv3, 1), "rogue RD transfer investor2 -> investor3 (bank-to-bank, never reported)");
  const rogueOut = new Set((await chainOutputs(bi.c, must(rogue.transactionHash, "rogue hash"), T.cash.address)).map(String));
  let flagged: ReturnType<BiLedger["unreported"]> = [];
  for (const start = Date.now(); flagged.length < rogueOut.size && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) {
    await L.sync();
    flagged = L.unreported(GRACE_MS);
  }
  const same = flagged.map((f) => f.commitment).sort().join(",") === [...rogueOut].sort().join(",");
  rec("B6", "BI: rogue transfer (never reported) is flagged unreported", "negative", `flagged after ${GRACE_MS / 1000}s grace: exactly the ${rogueOut.size} rogue outputs, sender investor2@node2`, `${flagged.length} flagged, sender=${[...new Set(flagged.map((f) => f.sender))].join("+")}`,
    rogueOut.size > 0 && same && flagged.every((f) => f.sender === inv2.lookup), rogue.id);
  happy("B7", "Option A BI reporting", "no mismatch on the real reports", `mismatch=${L.mismatches.length}`, L.mismatches.length === 0);
}

async function groupReg() {
  logger.log("\n== reg: InstrumentRegistry + shared validator");
  const stealth = (record: unknown): { valid: boolean; errors: string[]; hash: string; args?: any } =>
    JSON.parse(execFileSync("node", [path.join(__dirname, "src", "stealth-check.mjs")], { input: JSON.stringify(record) }).toString());
  const strip = ({ _note, ...rest }: any) => rest;
  const tok = (zeto: ZetoInstance) => ({ address: zeto.address, tokenName: ZETO_V1.tokenName });
  const rdTerms = strip(readJson(path.join(__dirname, "docs", "samples", "rd-terms.sample.json")));
  const dfTerms = strip(readJson(path.join(__dirname, "docs", "samples", "dfabi-terms.sample.json")));
  const P = life ?? { bond: T.bond, cash: T.cash };
  const rd = buildRdRecord(rdTerms, tok(P.cash));
  const df = buildDfabiRecord(dfTerms, tok(P.bond));
  const dfV2 = buildDfabiRecord({ ...dfTerms, "Listing and Restrictions": { ...dfTerms["Listing and Restrictions"], "Documentation Name": "Fictional series documentation, corrected (e2e)" } }, tok(P.bond));
  const clone = (r: any, f: (x: any) => void) => { const x = JSON.parse(JSON.stringify(r)); f(x); return x; };
  const id = (g: string, n: string) => catalogField(g, n).id;

  // validator: offline, exact messages from stealth validateRecord
  const vcases: [string, string, any, string][] = [
    ["V1", "RD record valid", rd, ""],
    ["V2", "DFABI record valid", df, ""],
    ["V3", "DFABI bad ISIN (check digit)", clone(df, (x) => (x.bdt[id("Security identifier and status", "Identifier Value")] = ["IDZETOTEST12"])), 'bdt.security_identifier_and_status_identifier_value: "IDZETOTEST12" is not a valid ISIN (ISO 6166 check digit)'],
    ["V4", "DFABI bad issuer LEI", clone(df, (x) => (x.bdt[id("Issuer", "Issuer LEI")] = "5493ZETOTEST00000284")), 'bdt.issuer_issuer_lei: "5493ZETOTEST00000284" is not a valid LEI (ISO 17442 mod-97)'],
    ["V5", "DFABI missing required Issue Price", clone(df, (x) => delete x.bdt[id("Pricing Data", "Issue Price")]), "bdt.pricing_data_issue_price is required"],
    ["V6", "DFABI forbidden field (Guarantor Name, not used for DFABI)", clone(df, (x) => (x.bdt[id("Guarantor", "Guarantor Name")] = "X")), "bdt.guarantor_guarantor_name is not used by profile DFABI"],
    ["V7", "record with unknown top-level field", clone(df, (x) => (x.foo = 1)), "foo is an unknown field"],
    ["V8", "record with unknown kind", clone(df, (x) => (x.kind = "XX")), 'kind "XX" has no profile'],
    ["V9", "RD bad issuer LEI", clone(rd, (x) => (x.extensions.cash.issuerLei = "5493ZETOTEST00000284")), 'extensions.cash.issuerLei: "5493ZETOTEST00000284" is not a valid LEI (ISO 17442 mod-97)'],
    ["V10", "RD missing currency", clone(rd, (x) => delete x.extensions.cash.currency), "extensions.cash.currency is required"],
  ];
  for (const [vid, name, record, err] of vcases) {
    const r = stealth(record);
    const pass = err === "" ? r.valid : !r.valid && r.errors.length === 1 && r.errors[0] === err;
    rec(vid, `Validator: ${name}`, err === "" ? "happy" : "negative", err === "" ? "valid" : `invalid: ${err}`, r.valid ? "valid" : r.errors.join("; "), pass);
  }
  // builder-level guards (bad terms never become a record)
  for (const [bid, name, f, re] of [
    ["V11", "builder rejects a 'Not used' DFABI field (Interest Rate)", () => buildDfabiRecord(clone(dfTerms, (x) => (x["Interest & Calculations"]["Interest Rate"] = "3.875")), tok(P.bond)), /not an input field/],
    ["V12", "builder rejects missing required Issue Price", () => buildDfabiRecord(clone(dfTerms, (x) => delete x["Pricing Data"]["Issue Price"]), tok(P.bond)), /"Issue Price" is required/],
  ] as const) await negCall(bid, `Validator: ${name}`, re, async () => f());
  if (!execute) return;

  const art = registryArtifact as any;
  const c = nodes[0];
  const pub = async (client: PaladinClient, from: string, to: string | undefined, fn: string, data: unknown, extra: Record<string, unknown> = {}) => {
    const txid = await client.ptx.sendTransaction({ type: TransactionType.PUBLIC, from, to, function: fn, abi: art.abi, data, ...extra } as any);
    const r = await client.pollForReceipt(txid, DEFAULT_POLL_TIMEOUT);
    return r ?? ({ id: txid, success: false, failureMessage: "no receipt" } as ITransactionReceipt);
  };
  const call = (from: string, to: string, fn: string, data: unknown) => c.ptx.call({ type: TransactionType.PUBLIC, from, to, function: fn, abi: art.abi, data } as any);
  const addr = async (lookup: string) => c.getVerifiers(lookup)[0].address();
  const field = (res: any, name: string): any => {
    if (res === null || typeof res !== "object") return undefined;
    if (name in res) return res[name];
    for (const v of Object.values(res)) { const f = field(v, name); if (f !== undefined) return f; }
    return undefined;
  };
  const deployer = "bondIssuer@node1";
  const dep = ok(await pub(c, deployer, undefined, "", {}, { bytecode: art.bytecode }), "registry deploy");
  const reg = must(dep.contractAddress, "registry address");
  logger.log(`   registry ${reg}`);
  happy("G1", "Registry deploy (PUBLIC tx, not a Zeto contract)", "deployed", reg, !!reg, dep.id);
  for (const who of ["cashIssuer@node1", "bondIssuer@node1"]) ok(await pub(c, deployer, reg, "setRegistrar", { registrar: await addr(who), allowed: true }), `setRegistrar ${who}`);
  const isReg = await call(deployer, reg, "isRegistrar", [await addr("cashIssuer@node1")]);
  happy("G2", "Registry setRegistrar by owner", "cashIssuer is a registrar", JSON.stringify(isReg), isReg?.[0] === true || field(isReg, "output") === true || isReg === true);

  const rargs = (token: string, r: { args?: any }, uri: string) => ({ token, kind: r.args.kind, profileVersion: r.args.profileVersion, primaryId: r.args.primaryId, dataHash: r.args.dataHash, dataUri: uri });
  const sRd = stealth(rd), sDf = stealth(df), sDf2 = stealth(dfV2);
  for (const [gid, name, who, token, s, uri] of [
    ["G3", "RD", "cashIssuer@node1", P.cash.address, sRd, "https://instruments.invalid/e2e/rd.json"],
    ["G4", "DFABI", "bondIssuer@node1", P.bond.address, sDf, "https://instruments.invalid/e2e/dfabi.json"],
  ] as const) {
    const r = ok(await pub(c, who, reg, "register", rargs(token, s, uri)), `register ${name}`);
    const back = await call(deployer, reg, "getInstrument", { token });
    const onChain = hex(field(back, "dataHash"));
    happy(gid, `Registry register ${name}`, "on-chain dataHash == stealth recordHash", `onChain=${onChain} recordHash=${s.hash}`, onChain === hex(s.hash), r.id);
  }
  const rv = ok(await pub(c, "bondIssuer@node1", reg, "registerVersion", rargs(P.bond.address, sDf2, "https://instruments.invalid/e2e/dfabi-v2.json")), "registerVersion");
  const n = (res: any) => field(res, "output") ?? res?.[0] ?? res;
  const [cnt, v1, v2] = [await call(deployer, reg, "versionCount", { token: P.bond.address }), await call(deployer, reg, "getInstrumentVersion", { token: P.bond.address, version: 1 }), await call(deployer, reg, "getInstrumentVersion", { token: P.bond.address, version: 2 })];
  happy("G5", "Registry registerVersion DFABI correction", "versionCount 2, v1 hash unchanged, v2 hash = new record", `count=${n(cnt)} v1=${hex(field(v1, "dataHash"))} v2=${hex(field(v2, "dataHash"))}`,
    String(n(cnt)) === "2" && hex(field(v1, "dataHash")) === hex(sDf.hash) && hex(field(v2, "dataHash")) === hex(sDf2.hash), rv.id);

  await negTx("G6", "Registry register the same token twice", /PD012216.*AlreadyRegistered\(\)/, () => pub(c, "bondIssuer@node1", reg, "register", rargs(P.bond.address, sDf, "https://instruments.invalid/e2e/dfabi.json")));
  await negTx("G7", "Registry registerVersion with another primaryId (ISIN)", /PD012216.*IdentityChanged\(\)/, () => pub(c, "bondIssuer@node1", reg, "registerVersion", { ...rargs(P.bond.address, sDf2, "https://instruments.invalid/e2e/x.json"), primaryId: "IDZETOTEST99" }));
  await negTx("G8", "Registry registerVersion with another kind (DFABI -> RD)", /PD012216.*IdentityChanged\(\)/, () => pub(c, "bondIssuer@node1", reg, "registerVersion", { ...rargs(P.bond.address, sDf2, "https://instruments.invalid/e2e/x.json"), kind: sRd.args.kind }));
  await negTx("G9", "Registry registerVersion for a token never registered", /PD012216.*NotRegisteredYet\(\)/, () => pub(c, "bondIssuer@node1", reg, "registerVersion", rargs(ethers.Wallet.createRandom().address, sDf2, "https://instruments.invalid/e2e/x.json")));
  await negTx("G10", "Registry register by a non-registrar (investor2@node2)", /PD012216.*NotRegistrar\(\)/, () => pub(nodes[1], "investor2@node2", reg, "register", rargs(ethers.Wallet.createRandom().address, sRd, "https://instruments.invalid/e2e/x.json")));
  await negTx("G11", "Registry setRegistrar by a non-owner (cashIssuer)", /PD012216.*NotOwner\(\)/, () => pub(c, "cashIssuer@node1", reg, "setRegistrar", { registrar: "0x000000000000000000000000000000000000dEaD", allowed: true }));
  await negTx("G12", "Registry register with empty dataUri", /PD012216.*EmptyInput\(\)/, () => pub(c, "bondIssuer@node1", reg, "register", rargs(ethers.Wallet.createRandom().address, sDf, "")));
  await negCall("G13", "Registry getInstrument of an unknown token (read call: Paladin gives the raw selector, 0x9c848c00 = UnknownInstrument())", /PD011513.*0x9c848c00/, () => call(deployer, reg, "getInstrument", { token: ethers.Wallet.createRandom().address }));
  await negCall("G14", "Registry getInstrumentVersion out of range (99) (0x9c848c00 = UnknownInstrument())", /PD011513.*0x9c848c00/, () => call(deployer, reg, "getInstrumentVersion", { token: P.bond.address, version: 99 }));
}

async function groupDvp() {
  logger.log("\n== dvp: Atom negatives");
  await freshTokens([inv2]);
  const s0 = await snap(seller, inv2);
  // D1 execute with one leg undelegated
  const bond = await bondLeg(inv2);
  const cash = await cashLeg(inv2);
  const atom = await stdAtom(bond, cash);
  ok(await delegate(T.bond, seller, bond.lockId, atom.address), "DFABI delegateLock");
  const locked = await snap(seller, inv2);
  await negTx("D1", "DvP execute with the cash leg not delegated to the Atom", /PD012216.*LockUnauthorized\(/, () => atom.using(inv2.c).execute(inv2.v));
  await expectUnchanged("D2", "DvP failed execute moved nothing", locked);
  ok(await delegate(T.cash, inv2, cash.lockId, atom.address), "RD delegateLock");
  const exec = await atom.using(inv2.c).execute(inv2.v);
  await expectBalances("D3", "DvP same Atom executes once the missing leg is delegated", `bondCustodian -${BOND}/+${CASH}`, shift(s0, [[seller, -BOND, CASH], [inv2, BOND, -CASH]]), exec?.id);
  await negTx("D4", "DvP replay: executed Atom executes again", /PD012216.*AtomNotPending\(\)/, () => atom.using(inv2.c).execute(inv2.v));
  // D7 mismatched legs: each call sent to the other token's contract
  const b2 = await bondLeg(inv2);
  const c2 = await cashLeg(inv2);
  const bad = await createAtom([[T.cash.address, b2.call], [T.bond.address, c2.call]]);
  await delegateBoth(b2, c2, inv2, bad);
  const lk = await snap(seller, inv2);
  await negTx("D7", "Atom with mismatched legs (each call aimed at the other token's contract)", /PD012216.*(LockNotActive|LockUnauthorized)\(/, () => bad.using(inv2.c).execute(inv2.v));
  await expectUnchanged("D8", "mismatched-leg execute moved nothing", lk);
  // D9 finding: the Atom does not bind the commercial terms; a short-paid cash leg settles
  const s1 = await snap(seller, inv2);
  const b3 = await bondLeg(inv2);
  const c3 = await cashLeg(inv2, seller, 1n); // V1: the amount is pinned by createLock, so the buyer locks 1 RD up front
  const a3 = await stdAtom(b3, c3);
  await delegateBoth(b3, c3, inv2, a3);
  const e3 = await a3.using(inv2.c).execute(inv2.v);
  rec("D9", "FINDING: Atom does not bind amounts/recipients; cash leg of 1 instead of 10 still settles", "finding", "execute succeeds (terms must be checked off-chain before delegateLock; V1 pins them in the lock, the Atom still does not compare them)", e3?.success === true ? "settled with 1 RD for 100 DFABI" : `failed: ${e3?.failureMessage}`, e3?.success === true, e3?.id);
  await expectBalances("D10", "DvP short-paid swap moved exactly the encoded legs", "bondCustodian -100 DFABI +1 RD", shift(s1, [[seller, -BOND, 1n], [inv2, BOND, -1n]]), e3?.id);
  // Double spend last: failed-assemble txs are the prime suspect for the sequencer stall seen in runs 1-2 (v1.0.0)
  // D5/D6: the lock the executed Atom already spent. V1 loads the lock-info state by lockId (spent with the lock).
  await negTx("D5", "Double spend: re-prepare spendLock of an already-spent lock", /PD210149/, () => T.bond.using(seller.c).prepareSpendLock(seller.v, { lockId: bond.lockId, from: seller.lookup, data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT));
  await negTx("D6", "Double spend: cancelLock of an already-spent lock", /PD210149/, () => reclaim(T.bond, seller, bond.lockId));
}

async function groupNeg() {
  logger.log("\n== neg: tampered legs, third party, cancelLock, over-lock, locked-state transfer, foreign lock");
  await freshTokens([inv2]);
  const s0 = await snap(seller, inv2);
  // N1 tampered output: V1 checks keccak(lockedInputs, lockedOutputs, outputs, data) against the spendCommitment
  // pinned at createLock before the proof, so the revert is InvalidUnlockHash (V0: "Invalid proof").
  for (const side of ["bond", "cash"] as const) {
    const bond = await bondLeg(inv2);
    const cash = await cashLeg(inv2);
    const atom = await createAtom([[T.bond.address, side === "bond" ? tampered(bond) : bond.call], [T.cash.address, side === "cash" ? tampered(cash) : cash.call]]);
    await delegateBoth(bond, cash, inv2, atom);
    const locked = await snap(seller, inv2);
    await negTx(`N${side === "bond" ? 1 : 2}`, `DvP execute with a tampered ${side} output (amount/recipient changed)`, /PD012216.*(InvalidUnlockHash|Invalid proof)/, () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged(`N${side === "bond" ? 1 : 2}b`, `tampered ${side} execute moved nothing`, locked);
  }
  // N3 third party delegates someone else's lock (only the current spender may)
  const s1 = await snap(seller, inv2);
  const bLock = await createLock(T.bond, seller, inv2, BOND);
  const cLock = await createLock(T.cash, inv2, seller, CASH);
  await negTx("N3", "investor3 delegates bondCustodian's DFABI lock (not the spender)", /PD012216.*LockUnauthorized\(/, async () => delegate(T.bond, inv3, bLock.lockId, await inv3.v.address()));
  await negTx("N4", "investor3 delegates investor2's RD lock (not the spender)", /PD012216.*LockUnauthorized\(/, async () => delegate(T.cash, inv3, cLock.lockId, await inv3.v.address()));
  // N5 foreign lock: investor3 tries to cancel bondCustodian's lock (lock-info is not in its state store)
  await negTx("N5", "Privacy: investor3 cancelLock on bondCustodian's lock", /PD210149/, () => reclaim(T.bond, inv3, bLock.lockId));
  // N6 locked funds cannot be transferred: ask for more than balance - locked
  const now = await snap(seller, inv2);
  const sb = must(now.get(seller), "seller").bond;
  const held = await heldStates(seller.c, T.bond.address);
  logger.log(`   N6 diagnostics: balanceOf=${sb}; unspent states: ${held.map((x) => `${x.data.amount}${x.data.locked ? "L" : ""}`).join(",")}`);
  await negTx("N6", "Transfer of a locked state: amount above balance excluding the lock", new RegExp(`PD210033.*available=${sb}\\)`), () => transferOf(seller, T.bond, inv2, Number(sb) + 1));
  // N7 spendLock on a lock id that does not exist
  await negTx("N7", "prepareSpendLock of a lock id that was never created", /PD210149/, () => T.bond.using(seller.c).prepareSpendLock(seller.v, { lockId: "0x" + "ab".repeat(32), from: seller.lookup, data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT));
  // N8 over-lock
  await negTx("N8", "Lock more than the balance", /PD210033.*Insufficient funds/, () => T.bond.using(seller.c).createLock(seller.v, { from: seller.lookup, recipients: [{ to: inv2.v, amount: 10_000_000, data: "0x" }], unlockData: "0x", data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT));
  // N9 happy: the owners reclaim their still-owned locks (cancelLock)
  const r1 = ok(await reclaim(T.bond, seller, bLock.lockId), "cancelLock DFABI");
  const r2 = ok(await reclaim(T.cash, inv2, cLock.lockId), "cancelLock RD");
  await expectBalances("N9", "cancelLock of a lock never delegated to an Atom", "both back to the pre-lock balances", s1, `${r1.id} ${r2.id}`);
  void s0;
}

async function groupF1b() {
  logger.log("\n== f1b: cancelLock after prepareSpendLock (V0 finding \"cannot reclaim after prepareTransferLocked\", PD210134, re-check)");
  await freshTokens([inv2]);
  const s0 = await snap(seller, inv2);
  const bond = await bondLeg(inv2);
  const cash = await cashLeg(inv2);
  // V0 failed because transferLocked read its inputs as AVAILABLE states. V1 spendLock/cancelLock read the locked
  // coins by id (states.go:234 getCoinStatesByID, any confirm/spend status). Not known from source whether the
  // sequencer still reserves them for the prepared tx, so the outcome is RECORDED, not asserted.
  const outcome = async (id: string, name: string, zeto: ZetoInstance, p: Party, lockId: string) => {
    let why: string | undefined;
    let tx = "-";
    try {
      const r = await reclaim(zeto, p, lockId);
      tx = r?.id ?? "-";
      if (r?.success !== true) why = r?.failureMessage ?? "no receipt";
    } catch (e) { why = msgOf(e); }
    rec(id, `${name}: cancelLock after prepareSpendLock`, "finding", "outcome recorded (V0: failed with PD210134)", why === undefined ? "cancelLock SUCCEEDED: V0 finding does not apply on V1" : `cancelLock failed: ${why}`, true, tx);
    return why === undefined;
  };
  const [bondBack, cashBack] = [await outcome("F1", "Seller reclaims DFABI", T.bond, seller, bond.lockId), await outcome("F2", "Buyer reclaims RD", T.cash, inv2, cash.lockId)];
  const want = shift(s0, [[seller, bondBack ? 0n : -BOND, 0n], [inv2, 0n, cashBack ? 0n : -CASH]]);
  await expectBalances("F3", "Balances match the recorded outcome (a failed cancelLock leaves the lock held back)", "balances consistent with outcome", want);
  const relockOnce = async (zeto: ZetoInstance, p: Party, to: Party, amount: bigint) => (await createLock(zeto, p, to, amount)).receipt;
  const r3 = ok(await relockOnce(T.bond, seller, inv2, BOND), "next DFABI lock");
  const r4 = ok(await relockOnce(T.cash, inv2, seller, CASH), "next RD lock");
  await expectBalances("F4", "Other funds are unaffected: the next locks still go through", "the 2 new locks are held back too", shift(want, [[seller, -BOND, 0n], [inv2, 0n, -CASH]]), `${r3.id} ${r4.id}`);
}

async function groupF2() {
  logger.log("\n== f2: Atom.cancel() after delegation");
  await freshTokens([inv2]);
  const bond = await bondLeg(inv2);
  const cash = await cashLeg(inv2);
  const atom = await stdAtom(bond, cash);
  await delegateBoth(bond, cash, inv2, atom);
  const locked = await snap(seller, inv2);
  const c = await cancelAtom(atom, inv4);
  rec("X1", "FINDING: Atom.cancel() has no access control; a third party (investor4) cancels a pending Atom", "finding", "cancel by non-participant succeeds", c?.success === true ? "cancel succeeded" : `cancel failed: ${c?.failureMessage}`, c?.success === true, c?.id);
  await negTx("X2", "Cancelled Atom executes", /PD012216.*AtomNotPending\(\)/, () => atom.using(inv2.c).execute(inv2.v));
  // V1: the Atom is now the lock spender, and cancelLock is spender-only, so the owner cannot get the funds back.
  await negTx("X3", "Seller cancelLock on the DFABI lock delegated to the cancelled Atom", /PD012216.*LockUnauthorized\(|PD012616/, () => reclaim(T.bond, seller, bond.lockId));
  await negTx("X4", "Buyer cancelLock on the RD lock delegated to the cancelled Atom", /PD012216.*LockUnauthorized\(|PD012616/, () => reclaim(T.cash, inv2, cash.lockId));
  await expectUnchanged("X5", "FINDING data: both legs stay locked (balances reduced by the locks)", locked);
}

function groupKyc() {
  logger.log("\n== kyc: smoke-zeto.ts on the bootstrap tokens (V1 Zeto_Anon; the V0 KYC tokens are retired)");
  const r = spawnSync("npx", ["ts-node", "smoke-zeto.ts"], { cwd: __dirname, timeout: 15 * 60 * 1000, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const pass = r.status === 0 && /Zeto smoke: PASS/.test(out);
  happy("K1", "Bootstrap baseline: RD + DFABI private transfer + withdraw on the V1 Zeto_Anon bootstrap tokens", "smoke-zeto.ts exits 0 and prints 'Zeto smoke: PASS'", pass ? "Zeto smoke: PASS" : out.split("\n").slice(-3).join(" "), pass);
  // A failed smoke while a pod restarted is the cluster's fault, not the feature's: mark it BLOCKED.
  let restarted = false;
  try { restarted = podState() !== podBaseline; } catch { /* pod check unavailable */ }
  const k1 = rows[rows.length - 1];
  if (!pass && restarted) { k1.status = "BLOCKED"; k1.actual = `BLOCKED - a Paladin pod restarted during the smoke (${k1.actual.slice(0, 120)})`; }
}

// ---- report ----

function writeReport(file: string) {
  const count = (k: Row["kind"]) => ({ pass: rows.filter((r) => r.kind === k && r.status !== "FAIL" && r.status !== "BLOCKED").length, total: rows.filter((r) => r.kind === k).length });
  const [h, n, f] = [count("happy"), count("negative"), count("finding")];
  const blocked = rows.filter((r) => r.status === "BLOCKED");
  const fails = rows.filter((r) => r.status === "FAIL");
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    "# Zeto end-to-end report, Zeto V1 (Paladin main + PR #1189)",
    "",
    "Live Paladin cluster (ACK), Paladin main 559567e38 + PR #1189 merge 82fbd49ce, Zeto v0.5.1 (V1 axis), Zeto_Anon, Zeto-vs-Zeto only. node1 = BI. Generated by `spike-zeto-e2e.ts`.",
    "",
    `Totals: happy ${h.pass}/${h.total}, negative ${n.pass}/${n.total}, findings ${f.pass}/${f.total} recorded as documented, FAIL ${fails.length}, BLOCKED ${blocked.length}.`,
    "",
    "| ID | Feature | Kind | Expected | Actual | Status | Tx |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${esc(r.feature)} | ${r.kind} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.status} | ${r.tx} |`),
    "",
    "## FAIL",
    ...(fails.length ? fails.map((r) => `- ${r.id} ${r.feature}: ${r.actual}`) : ["- none"]),
    "",
    "## BLOCKED",
    ...(blocked.length ? blocked.map((r) => `- ${r.id} ${r.feature}: ${r.actual}`) : ["- none"]),
    "",
    "## FINDINGS",
    ...rows.filter((r) => r.kind === "finding").map((r) => `- ${r.id} ${r.feature}: ${r.actual}`),
    "",
    "## Skipped",
    "- BI offline (node1 restart, then reports queue and BI verifies on return): SKIPPED - needs user approval for the node1 restart; see spike-zeto-bi-offline.ts.",
    "",
    "## Not implemented / not exercised",
    "- Burn: the Zeto SDK has no burn; redeem is `withdraw` (ERC20 release), covered by W1/W2.",
    "- Unlock: V1 reclaim is `cancelLock` (spender-only, covered by F1a/N9); impossible after a delegation to a cancelled Atom (X3/X4). F1-F3 record whether it works after prepareSpendLock.",
    "- V1 DvP is exercised on Zeto_Anon only (KYC tokens: V0 / Paladin v1.0.0 had no transferLocked circuit; V1 KYC lock circuits are not tested here).",
    "- The only PUBLIC txs to a Zeto contract are setERC20 (phase 0) and delegateLock (V1 hand-over to the Atom); the v1.0.0 poison pill is fixed on main.",
    "- A Zeto deposit without ERC20 allowance (base-ledger revert of a domain tx) is not tested.",
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  logger.log(`report: ${file}`);
}

const execute = process.argv.includes("--execute");
const ONLY = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "").split(",").filter(Boolean);
const want = (g: string) => ONLY.length === 0 || ONLY.includes(g);

async function main() {
  logger.log("=== Zeto end-to-end: RD + DFABI happy and negative paths (Zeto_Anon, Zeto-vs-Zeto) ===");
  logger.log("ID | feature | kind | expected | actual | status | tx");
  if (!execute) {
    // The offline part: the shared validator cases need no cluster.
    life = undefined;
    T = { bond: new ZetoInstance(nodes[0], "0x" + "ab".repeat(20)), cash: new ZetoInstance(nodes[0], "0x" + "cd".repeat(20)), bondErc20: "", cashErc20: "" };
    await groupReg();
    logger.log(`\nDRY RUN -- ${rows.length} offline cases checked, nothing sent. Pass --execute to run the cluster groups.`);
    process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
  }
  const withLife = want("life") || want("bi") || want("reg");
  const withBi = want("bi");
  const sets = (withLife ? 1 : 0) + ["dvp", "neg", "f1b", "f2"].filter(want).length;
  for (const [i, n] of nodes.entries()) await n.pstate.listSchemas("zeto").catch((e) => { throw new Error(`node${i + 1} port-forward is down (${msgOf(e).slice(0, 80)}); tell lead, do not restart it`); });
  podBaseline = podState();
  logger.log(`pods at start:\n${podBaseline}`);
  factory = must(await newAtomFactory(cashIssuer.c, cashIssuer.v), "AtomFactory");
  logger.log(`atomFactory=${factory.address}\n== phase 0: deploy + setERC20 for ${sets} token set(s)`);
  await issueAll(sets);
  podsStillHealthy("phase 0");
  const groups: [string, () => Promise<void> | void][] = [
    ["life", async () => { if (withLife) await groupLife(withBi); }],
    ["reg", async () => { if (want("reg")) await groupReg(); }],
    ["dvp", async () => { if (want("dvp")) await groupDvp(); }],
    ["neg", async () => { if (want("neg")) await groupNeg(); }],
    ["f1b", async () => { if (want("f1b")) await groupF1b(); }],
    ["f2", async () => { if (want("f2")) await groupF2(); }],
    ["kyc", () => { if (want("kyc")) groupKyc(); }],
  ];
  for (const [name, run] of groups) {
    try {
      await run();
    } catch (e) {
      rec(`${name}-abort`, `group ${name} aborted`, "happy", "group completes", msgOf(e), false);
      if (/^STOP/.test(msgOf(e))) throw e;
    }
    podsStillHealthy(`group ${name}`);
  }
  const failed = rows.filter((r) => r.status === "FAIL");
  logger.log(`\n${rows.length - failed.length - rows.filter((r) => r.status === "BLOCKED").length}/${rows.length} cases ok (PASS or documented FINDING)`);
  failed.forEach((r) => logger.log(`  FAIL ${r.id} ${r.feature}: ${r.actual.slice(0, 200)}`));
  writeReport(ONLY.length ? path.join(__dirname, "out", "e2e-partial.md") : REPORT_FILE);
  logger.log(`Zeto e2e: ${failed.length ? "FAIL" : "PASS"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  logger.error("Zeto e2e: FAIL", err);
  if (rows.length) writeReport(path.join(__dirname, "out", "e2e-partial.md"));
  process.exit(1);
});
