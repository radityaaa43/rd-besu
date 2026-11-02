/*
 * BI offline test for Option A reporting (docs/plans/2026-10-16-option-a-bi-reporting.md). BI is
 * bi@node1, the same node as cashIssuer / bondIssuer / bondCustodian. While node1 is DOWN, banks
 * (node2 <-> node3) keep settling Zeto flows among themselves and keep sending their reports; when
 * node1 is back, the queued reports reach BI and BI verifies every output against the chain.
 *
 * Nothing that needs node1 identities can run in the outage (deploy, mint, BI's own legs, AtomFactory
 * create): all of that, and every balance the outage flows need, is issued BEFORE the outage.
 *
 * Who stops node1: by default the OPERATOR deletes pod paladin-node1-0 (the script only polls HTTP and
 * never touches kubectl). With --delete-pod the script deletes that one pod itself, once, right after
 * the prep is verified (kubectl, kubeconfig ./alibaba.yaml or --kubeconfig=; the StatefulSet recreates
 * it; the operator must restore the node1 port-forward). Without --execute nothing is sent or deleted.
 * Steps:
 *   1  pre-check: node1..4 answer on their HTTP port-forwards; BI's current view of the reports
 *   P  prep (node1 up, slow): fresh V1 Zeto_Anon DFABI + RD, groups {bank, bi@node1}, deposits
 *      investor2 DFABI and investor3 RD (their balances), V1 locks + prepared spendLock + Atom +
 *      delegateLockV1 for the bank-to-bank DvP, all reported and verified by BI. Prints "WAITING FOR
 *      NODE1 DOWN" (or deletes the pod when --delete-pod).
 *   2  wait until node1's HTTP port stops answering (polled over HTTP)
 *   3  while node1 is down, bank-to-bank only: RD transfer investor3->investor2, DFABI transfer
 *      investor2->investor3, Atom execute (DvP: DFABI investor2->investor3, RD investor3->investor2,
 *      executed by investor3); each with a receipt, timestamps, tx hash, a "node1 still down" probe,
 *      and the banks' reports sent (they must queue, not error)
 *   4  wait until node1 answers again; a FRESH BI ledger (cursor 0) must verify every output of
 *      step 3, see exactly the reports sent, no mismatch, no unreported output on chain
 *   5  negative: no fund loss (exact balance deltas); node1's RPC refuses while down; a BI-issued
 *      mint is NOT possible while BI is down (BI is the issuer on node1: this is the cost of the topology)
 *
 * SAFE BY DEFAULT: dry run (step 1 only, read-only, plus the plan) unless --execute. Run from this directory.
 *   npx ts-node spike-zeto-bi-offline.ts [--execute] [--delete-pod] [--kubeconfig=PATH]
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
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
const now = () => new Date().toISOString();
const BOND = 100n;
const CASH = 10n;
const WAIT_DOWN_MS = 20 * 60_000; // how long to wait for node1 to go down
const WAIT_UP_MS = 10 * 60_000;
const BI_POD = "paladin-node1-0";
const argv = process.argv.slice(2);
const DELETE_POD = argv.includes("--delete-pod");
const KUBECONFIG = argv.find((a) => a.startsWith("--kubeconfig="))?.split("=")[1] ?? path.join(__dirname, "alibaba.yaml"); // never printed

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
const [inv2, inv3] = ["investor2@node2", "investor3@node3"].map(party); // the banks that trade during the outage
const bi = party("bi@node1");
const probeClient = new PaladinClient(nodeConnections[0].clientOptions); // node1 (BI) liveness only

function must<V>(value: V | undefined | null, what: string): V {
  if (value === undefined || value === null) throw new Error(`${what} missing`);
  return value;
}
function ok(r: ITransactionReceipt | undefined, what: string): ITransactionReceipt {
  if (r?.success !== true) throw new Error(`${what} failed: ${r?.failureMessage ?? "no receipt"}`);
  return r;
}
const txOf = (token: Token, r: ITransactionReceipt | undefined, what: string): Tx => ({ token, txHash: must(ok(r, what).transactionHash, `${what} txHash`) });

// HTTP liveness over the port-forward, bounded to 2 s (a dead forward can hang).
const answers = (c: PaladinClient) =>
  Promise.race([c.bidx.getConfirmedBlockHeight().then(() => true, () => false), sleep(2000).then(() => false)]);

type Row = { id: string; what: string; expected: string; actual: string; status: "PASS" | "FAIL" | "INCONCLUSIVE" | "INFO" };
const rows: Row[] = [];
function row(id: string, what: string, expected: string, actual: string, status: Row["status"]) {
  rows.push({ id, what, expected, actual, status });
  logger.log(`${status} ${id} ${what} -- ${actual.slice(0, 400)}`);
}

// ---- helpers (same calls as spike-zeto-bi.ts / spike-zeto-dvp-zz.ts) ----
// ponytail: duplicated from spike-zeto-bi.ts rather than refactoring a proven script; the upgrade
// path is the shared src/zeto-flow.ts noted in spike-zeto-e2e.ts.
async function publicTx(p: Party, to: string, fn: string, data: Record<string, unknown>) {
  const id = await p.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, from: p.lookup, to, function: fn, abi: erc20Artifact.abi, data });
  ok(await p.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT), `${fn} from ${p.lookup}`);
}
// V1-axis Zeto_Anon + ERC20 + setERC20 up front, each awaited. The up-front phase is OPTIONAL on Paladin
// main (the v1.0.0 PUBLIC-tx resume poison pill is fixed upstream); kept as is.
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
// V1 leg: createLock (recipient pinned) + prepareSpendLock; the createLock tx is reported by the locker.
async function leg(tok: Token, owner: Party, to: Party, amount: bigint) {
  const l = await createLock(tok.zeto, owner, to, amount);
  const p = await prepareSpend(tok.zeto, owner, l.lockId);
  return { tx: txOf(tok, l.receipt, "createLock"), lockId: l.lockId, call: p.call, states: p.states };
}
async function report(p: Party, tx: Tx, known: any[] = []) {
  const r: Report = await buildReport(p.c, p.lookup, tx.token.name, tx.token.zeto.address, tx.txHash, known);
  await p.c.pgroup.sendMessage({ domain: "pente", group: must(p.group, `${p.lookup} group`), topic: REPORT_TOPIC, data: r });
  return r;
}
const balance = async (tok: Token, p: Party) => BigInt((await tok.zeto.using(p.c).balanceOf(p.v, { account: p.lookup })).totalBalance);
const biMessages = async (c: PaladinClient) => ((await c.pgroup.queryMessages({ limit: 500, eq: [{ field: "topic", value: REPORT_TOPIC }] } as any)) ?? []).length;

// ---- step 1 ----
async function precheck() {
  const heights: string[] = [];
  for (const [i, c] of nodes.entries()) {
    const up = await answers(c);
    heights.push(`node${i + 1}=${up ? "up" : "DOWN"}`);
    if (!up) throw new Error(`step 1: node${i + 1} does not answer on ${nodeConnections[i].clientOptions.url}`);
  }
  const msgs = await biMessages(bi.c);
  const height = await bi.c.bidx.getConfirmedBlockHeight();
  row("S1", "pre-check: node1..4 answer on their HTTP port-forwards; BI's view recorded", "all 4 answer", `${heights.join(" ")}; BI block=${height}; ${REPORT_TOPIC} messages delivered to BI so far=${msgs}`, "PASS");
}

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== BI offline: node1 (BI) down while banks settle, reports queue and BI verifies on return ===");
  if (!execute) {
    logger.log("\nPlan (nothing is sent or deleted without --execute):");
    logger.log("  P  node1 up: deploy V1 Zeto_Anon DFABI + RD (BI-owned), groups {investor2, bi@node1} and {investor3, bi@node1},");
    logger.log("     deposit DFABI to investor2 (node2) and RD to investor3 (node3), createLock + prepareSpendLock + Atom + delegateLockV1 for a bank-to-bank DvP,");
    logger.log("     banks report, BI verifies the baseline");
    logger.log(DELETE_POD
      ? `  2  --delete-pod: THE SCRIPT deletes pod ${BI_POD} once (kubectl, namespace paladin, kubeconfig from ./alibaba.yaml or --kubeconfig=, never printed), then waits for node1 HTTP to stop answering`
      : `  2  the OPERATOR deletes pod ${BI_POD}; the script only polls node1 HTTP (up to ${WAIT_DOWN_MS / 60000} min) and never calls kubectl (pass --delete-pod to let it delete the pod itself)`);
    logger.log("  3  node1 down: RD transfer investor3->investor2, DFABI transfer investor2->investor3, Atom execute (DvP, executed by investor3); banks send reports");
    logger.log("  4  node1 back: a fresh BI ledger must verify every output, no mismatch, nothing unreported");
    logger.log("\nDRY RUN -- step 1 only (read-only pre-check below). Pass --execute to run prep and the outage.");
    await precheck().catch((e) => logger.log(`(pre-check skipped in dry-run: ${String((e as Error).message).slice(0, 120)})`)); // needs the port-forwards; --execute still fails hard
    return;
  }
  await precheck();

  // ---- P: prep, node1 up ----
  const factory: AtomFactory = must(await newAtomFactory(cashIssuer.c, cashIssuer.v), "AtomFactory");
  const fromBlock = await bi.c.bidx.getConfirmedBlockHeight();
  const bond = await issueToken("DFABI", bondIssuer);
  const cash = await issueToken("RD", cashIssuer);
  logger.log(`   dfabi=${bond.zeto.address} rd=${cash.zeto.address} fromBlock=${fromBlock}`);
  for (const p of [inv2, inv3]) {
    const g = must(await new PenteFactory(p.c, "pente").newPrivacyGroup({ name: `bi-offline-${p.lookup.replace("@", ".")}-${Date.now()}`, members: [p.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT), "group");
    p.group = g.group.id;
    logger.log(`   group {${p.lookup}, bi@node1} = ${g.group.id}`);
  }
  const addressBook = new Map<string, string>();
  const ownerBook = new Map<string, string>();
  for (const p of [cashIssuer, bondIssuer, inv2, inv3]) {
    addressBook.set((await bi.c.ptx.resolveVerifier(p.lookup, "ecdsa:secp256k1", "eth_address")).toLowerCase(), p.lookup);
    ownerBook.set((await bi.c.ptx.resolveVerifier(p.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)).toLowerCase(), p.lookup);
  }
  const contracts = new Map([[bond.zeto.address.toLowerCase(), "DFABI"], [cash.zeto.address.toLowerCase(), "RD"]]);
  const newLedger = (c: PaladinClient) => new BiLedger(c, contracts, addressBook, ownerBook, fromBlock);

  // Everything that needs a node1 identity happens HERE. Funds: investor2 2 x 100 DFABI (one locked for the
  // DvP, one for the transfer); investor3 10 RD (DvP cash leg) + 5 RD (transfer). Each depositor and locker
  // reports; the DvP is fully prepared and delegated, so only Atom.execute runs in the outage.
  const prepTxs: { p: Party; tx: Tx }[] = [];
  for (const t of await deposits(bondIssuer, inv2, bond, 2, BOND)) prepTxs.push({ p: inv2, tx: t });
  for (const t of await deposits(cashIssuer, inv3, cash, 1, CASH)) prepTxs.push({ p: inv3, tx: t });
  for (const t of await deposits(cashIssuer, inv3, cash, 1, 5n)) prepTxs.push({ p: inv3, tx: t });
  const bLeg = await leg(bond, inv2, inv3, BOND); // investor2 sells DFABI to investor3
  const cLeg = await leg(cash, inv3, inv2, CASH); // investor3 pays RD to investor2
  prepTxs.push({ p: inv2, tx: bLeg.tx }, { p: inv3, tx: cLeg.tx });
  const atom: Atom = must(await factory.create(cashIssuer.v, [{ contractAddress: bond.zeto.address, callData: bLeg.call }, { contractAddress: cash.zeto.address, callData: cLeg.call }]), "Atom");
  ok(await delegateLock(bond.zeto, inv2, bLeg.lockId, atom.address), "DFABI delegateLock");
  ok(await delegateLock(cash.zeto, inv3, cLeg.lockId, atom.address), "RD delegateLock");
  for (const { p, tx } of prepTxs) await report(p, tx);

  // BI baseline (node1 up): every prep output verified.
  const baseLedger = newLedger(bi.c);
  const prepWant = new Set<string>();
  for (const { tx } of prepTxs) for (const o of await chainOutputs(bi.c, tx.txHash, tx.token.zeto.address)) prepWant.add(o.toString());
  for (const start = Date.now(); [...prepWant].some((c) => !baseLedger.verified.has(c)) && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) await baseLedger.pollReports();
  const baseMsgs = await biMessages(bi.c);
  row("P1", "baseline before the outage: BI verified every prep output (deposits + locks)", `${prepWant.size}/${prepWant.size} verified, 0 mismatch`,
    `${[...prepWant].filter((c) => baseLedger.verified.has(c)).length}/${prepWant.size} verified, mismatch=${baseLedger.mismatches.length}, ${REPORT_TOPIC} messages at BI=${baseMsgs}`,
    [...prepWant].every((c) => baseLedger.verified.has(c)) && !baseLedger.mismatches.length ? "PASS" : "FAIL");
  if (rows[rows.length - 1].status === "FAIL") throw new Error("baseline failed; not taking node1 down");

  const snap = async () => ({ i2Bond: await balance(bond, inv2), i3Bond: await balance(bond, inv3), i2Cash: await balance(cash, inv2), i3Cash: await balance(cash, inv3) });
  const before = await snap();
  logger.log(`   balances before: ${JSON.stringify(before, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  // ---- step 2: node1 DOWN ----
  if (DELETE_POD) {
    logger.log(`${now()} --delete-pod: deleting pod ${BI_POD} (kubectl, namespace paladin)`);
    execFileSync("kubectl", ["--kubeconfig", KUBECONFIG, "-n", "paladin", "delete", "pod", BI_POD, "--wait=false"], { timeout: 30_000, stdio: "ignore" });
  }
  logger.log(`\n${now()} WAITING FOR NODE1 DOWN (poll ${nodeConnections[0].clientOptions.url}, up to ${WAIT_DOWN_MS / 60000} min).${DELETE_POD ? "" : ` Operator: delete pod ${BI_POD} now.`}`);
  let fails = 0;
  for (const start = Date.now(); fails < 2; await sleep(500)) {
    fails = (await answers(probeClient)) ? 0 : fails + 1;
    if (Date.now() - start > WAIT_DOWN_MS) throw new Error("node1 never went down; nothing was run in the outage");
  }
  const tDown = now();
  logger.log(`${tDown} NODE1 DOWN detected. Running bank-to-bank flows (node2 <-> node3).`);

  // ---- step 3: flows while node1 is down ----
  type Flow = { id: string; what: string; txs: Tx[]; start: string; end: string; downAtEnd: boolean; reports: Report[]; hash: string };
  const flows: Flow[] = [];
  const flow = async (id: string, what: string, run: () => Promise<{ txs: Tx[]; reports: () => Promise<Report[]> }>) => {
    const start = now();
    const { txs, reports } = await run();
    const end = now();
    const downAtEnd = !(await answers(probeClient));
    const sent = await reports(); // must queue, not throw, while BI is down
    flows.push({ id, what, txs, start, end, downAtEnd, reports: sent, hash: txs[0].txHash });
    logger.log(`${end} ${id} receipt ${txs[0].txHash} (start ${start}), node1 still down at receipt: ${downAtEnd}, ${sent.length} report(s) sent`);
  };
  const xfer = (tok: Token, from: Party, to: Party, what: string) => async () => {
    const tx = txOf(tok, await tok.zeto.using(from.c).transfer(from.v, { transfers: [{ to: to.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), what);
    return { txs: [tx], reports: async () => [await report(from, tx)] };
  };
  const dvp = async () => {
    const exec = must(ok(await atom.using(inv3.c).execute(inv3.v), "Atom execute").transactionHash, "execute txHash");
    const sBond: Tx = { token: bond, txHash: exec };
    const sCash: Tx = { token: cash, txHash: exec };
    // Seller (investor2) received RD and gave DFABI; buyer (investor3) received DFABI and gave RD. Both report both tokens.
    return { txs: [sBond, sCash], reports: async () => [await report(inv2, sCash, cLeg.states), await report(inv2, sBond, bLeg.states), await report(inv3, sCash, cLeg.states), await report(inv3, sBond, bLeg.states)] };
  };
  // DvP execute (no proving) in parallel with the two transfers (proving, sequential).
  await Promise.all([
    flow("F3", "Atom DvP execute: DFABI investor2@node2->investor3@node3, RD investor3->investor2 (bank-to-bank)", dvp),
    (async () => {
      await flow("F1", "RD private transfer investor3@node3 -> investor2@node2", xfer(cash, inv3, inv2, "RD transfer"));
      await flow("F2", "DFABI private transfer investor2@node2 -> investor3@node3", xfer(bond, inv2, inv3, "DFABI transfer"));
    })(),
  ]);
  const tFlows = now();
  for (const f of flows.sort((a, b) => a.id.localeCompare(b.id))) {
    row(f.id, f.what, "successful receipt on chain while node1 is down", `tx ${f.hash}; ${f.start} -> ${f.end}; node1 down at receipt=${f.downAtEnd}; ${f.reports.length} report(s) queued without error`,
      f.downAtEnd ? "PASS" : "INCONCLUSIVE");
  }
  const downAfter = !(await answers(probeClient));
  const heightAtEnd = await inv2.c.bidx.getConfirmedBlockHeight();
  const after = await snap();
  const delta = { i2Bond: after.i2Bond - before.i2Bond, i3Bond: after.i3Bond - before.i3Bond, i2Cash: after.i2Cash - before.i2Cash, i3Cash: after.i3Cash - before.i3Cash };
  // balanceOf excludes locked coins, so the two locked legs already left the "before" balances: the DvP only
  // adds what each side RECEIVES (investor3 +BOND, investor2 +CASH); the transfers move 1 unit each way.
  const wantDelta = { i2Bond: -1n, i3Bond: 1n + BOND, i2Cash: 1n + CASH, i3Cash: -1n };
  const same = (Object.keys(wantDelta) as (keyof typeof wantDelta)[]).every((k) => delta[k] === wantDelta[k]);
  const str = (o: object) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  row("N1", "no fund loss during the outage: exact private balance deltas", str(wantDelta), `${str(delta)} (node1 still down: ${downAfter})`, same ? "PASS" : "FAIL");
  row("N2", "BI's RPC refuses while down; reports are queued by the sending banks, not rejected", "node1 HTTP does not answer; every sendMessage resolved", `node1 answers=${!downAfter}; ${flows.reduce((n, f) => n + f.reports.length, 0)} sendMessage calls resolved`, downAfter && flows.every((f) => f.reports.length > 0) ? "PASS" : "INCONCLUSIVE");
  row("N3", "BI-originated actions while BI is down (mint, BI's own DvP leg, new AtomFactory)", "not possible", "BI is the issuer and the bond seller and lives on node1: issuance and BI's legs stop with node1. That is the cost of putting BI and the issuers on one node; the banks keep trading with the balances they already hold.", "INFO");

  // ---- step 4: node1 back, fresh BI ledger verifies ----
  logger.log(`\n${now()} flows done (${tDown} -> ${tFlows}). WAITING FOR NODE1 BACK (poll, up to ${WAIT_UP_MS / 60000} min).`);
  let oks = 0;
  for (const start = Date.now(); oks < 3; await sleep(1000)) {
    oks = (await answers(probeClient)) ? oks + 1 : 0;
    if (Date.now() - start > WAIT_UP_MS) throw new Error("node1 did not come back; reports not verified. Outage flows above are valid.");
  }
  const tBack = now();
  const t0 = Date.now();
  logger.log(`${tBack} NODE1 BACK`);
  const biNew = new PaladinClient(nodeConnections[0].clientOptions);
  // BI's indexer must be past the outage txs before any report is checked, or check() sees no events and records a false mismatch.
  for (const start = Date.now(); Date.now() - start < 180_000; await sleep(2000)) {
    if ((await biNew.bidx.getConfirmedBlockHeight().catch(() => 0)) >= heightAtEnd) break;
  }
  const ledger = newLedger(biNew);
  const outageWant = new Set<string>();
  for (const f of flows) for (const t of f.txs) for (const o of await chainOutputs(inv2.c, t.txHash, t.token.zeto.address)) outageWant.add(o.toString());
  const allWant = new Set([...prepWant, ...outageWant]);
  const missing = () => [...allWant].filter((c) => !ledger.verified.has(c));
  for (const start = Date.now(); missing().length && Date.now() - start < 180_000; await sleep(2000)) await ledger.pollReports().catch(() => 0);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  row("R1", "after node1 is back, a fresh BI ledger (cursor 0) verifies every output of the outage flows", `${outageWant.size}/${outageWant.size} verified`,
    `${[...outageWant].filter((c) => ledger.verified.has(c)).length}/${outageWant.size} verified ${secs}s after node1 answered (back at ${tBack}); duplicates merged=${ledger.duplicates}`,
    [...outageWant].every((c) => ledger.verified.has(c)) ? "PASS" : "FAIL");
  const sentOutage = flows.reduce((n, f) => n + f.reports.length, 0);
  const msgsNow = await biMessages(biNew);
  row("R2", "report messages delivered to BI exactly once each (baseline + outage)", `${baseMsgs + sentOutage} messages`, `${msgsNow} messages (baseline ${baseMsgs} + outage ${sentOutage})`, msgsNow === baseMsgs + sentOutage ? "PASS" : "FAIL");
  row("R3", "no mismatch in any report", "0 mismatches", `mismatch=${ledger.mismatches.length}${ledger.mismatches.length ? ` ${ledger.mismatches[0].status.reason}` : ""}`, ledger.mismatches.length === 0 ? "PASS" : "FAIL");
  await ledger.scanChain();
  const gap = ledger.unreported(0);
  row("R4", "BI chain scan from fromBlock: no unreported output flagged", "0 unreported", `${ledger.chain.size} chain outputs, ${ledger.verified.size} verified, ${gap.length} unreported${gap.length ? ` (${gap.map((g) => `${g.token} ${g.txHash.slice(0, 10)} sender=${g.sender}`).join("; ")})` : ""}`,
    ledger.chain.size > 0 && gap.length === 0 ? "PASS" : "FAIL");

  const md = [
    `BI offline run: node1 (BI) down detected ${tDown}, flows done ${tFlows}, node1 back ${tBack}. Tokens DFABI ${bond.zeto.address}, RD ${cash.zeto.address}.`,
    "", "| ID | what | expected | actual | status |", "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.what} | ${r.expected} | ${r.actual.replace(/\|/g, "/")} | ${r.status} |`),
  ].join("\n");
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "bi-offline.md"), md + "\n");
  logger.log("\n" + md);
  const bad = rows.filter((r) => r.status === "FAIL" || r.status === "INCONCLUSIVE");
  logger.log(`\nBI offline: ${bad.length ? (bad.some((r) => r.status === "FAIL") ? "FAIL" : "INCONCLUSIVE") : "PASS"} (${rows.filter((r) => r.status === "PASS").length} PASS)`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => {
  logger.error("BI offline: FAIL", err);
  process.exit(1);
});
