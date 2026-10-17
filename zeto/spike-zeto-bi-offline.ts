/*
 * BI offline test for Option A reporting (docs/plans/2026-10-16-option-a-bi-reporting.md): while
 * BI's node (node4) is DOWN, banks keep settling Zeto flows and keep sending their reports; when
 * node4 is back, the queued reports reach BI and BI verifies every output against the chain.
 *
 * LEAD restarts node4 (deletes pod paladin-node4-0). This script never touches kubectl.
 * Steps (docs: lead task 2026-10-17):
 *   1  pre-check: node1..4 answer on their HTTP port-forwards; BI's current view of the reports
 *   P  prep (node4 up, slow): fresh Zeto_Anon DFABI + RD, groups {bank, bi}, deposits + locks +
 *      Atom + delegateLock, all reported and verified by BI. Prints "WAITING FOR NODE4 DOWN".
 *   2  wait until node4's HTTP port stops answering (polled over HTTP, no kubectl)
 *   3  while node4 is down, bank-to-bank only: RD transfer node1->node2, DFABI transfer
 *      node1->node2, Atom execute (DvP, inv2 on node2); each with a receipt, timestamps, tx hash,
 *      a "node4 still down" probe, and the bank's report sent (it must queue, not error)
 *   4  wait until node4 answers again; a FRESH BI ledger (cursor 0) must verify every output of
 *      step 3, see exactly the reports sent, no mismatch, no unreported output on chain
 *   5  negative: no fund loss (exact balance deltas); BI's RPC refuses while down. BI has no
 *      issuer/minter role, so there is no BI-issued mint to test.
 *
 * SAFE BY DEFAULT: dry run (step 1 only, read-only) unless --execute. Run from this directory.
 *   npx ts-node spike-zeto-bi-offline.ts [--execute]
 */
import * as fs from "fs";
import * as path from "path";
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
const now = () => new Date().toISOString();
const BOND = 100n;
const CASH = 10n;
const WAIT_DOWN_MS = 20 * 60_000; // how long to wait for lead to take node4 down
const WAIT_UP_MS = 10 * 60_000;

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
const probeClient = new PaladinClient(nodeConnections[3].clientOptions); // node4 liveness only

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
  logger.log("=== BI offline: node4 down while banks settle, reports queue and BI verifies on return ===");
  await precheck();
  if (!execute) {
    logger.log("\nDRY RUN -- step 1 only (read-only). Pass --execute to run prep and wait for node4 to go down.");
    return;
  }

  // ---- P: prep, node4 up ----
  const factory: AtomFactory = must(await newAtomFactory(cashIssuer.c, cashIssuer.v), "AtomFactory");
  const fromBlock = await bi.c.bidx.getConfirmedBlockHeight();
  const bond = await issueToken("DFABI", bondIssuer);
  const cash = await issueToken("RD", cashIssuer);
  logger.log(`   dfabi=${bond.zeto.address} rd=${cash.zeto.address} fromBlock=${fromBlock}`);
  for (const p of [seller, inv2]) {
    const g = must(await new PenteFactory(p.c, "pente").newPrivacyGroup({ name: `bi-offline-${p.lookup.replace("@", ".")}-${Date.now()}`, members: [p.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT), "group");
    p.group = g.group.id;
    logger.log(`   group {${p.lookup}, bi@node4} = ${g.group.id}`);
  }
  const addressBook = new Map<string, string>();
  const ownerBook = new Map<string, string>();
  for (const p of [cashIssuer, bondIssuer, seller, inv2, inv3]) {
    addressBook.set((await bi.c.ptx.resolveVerifier(p.lookup, "ecdsa:secp256k1", "eth_address")).toLowerCase(), p.lookup);
    ownerBook.set((await bi.c.ptx.resolveVerifier(p.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)).toLowerCase(), p.lookup);
  }
  const contracts = new Map([[bond.zeto.address.toLowerCase(), "DFABI"], [cash.zeto.address.toLowerCase(), "RD"]]);
  const newLedger = (c: PaladinClient) => new BiLedger(c, contracts, addressBook, ownerBook, fromBlock);

  // Funds: seller 2 x 100 DFABI + 5 RD (RD sender node1), investor2 10 RD (DvP cash leg). Every
  // depositor and locker reports; the DvP is fully prepared so only Atom.execute runs in the outage.
  const prepTxs: { p: Party; tx: Tx }[] = [];
  for (const t of await deposits(bondIssuer, seller, bond, 2, BOND)) prepTxs.push({ p: seller, tx: t });
  for (const t of await deposits(cashIssuer, seller, cash, 1, 5n)) prepTxs.push({ p: seller, tx: t });
  for (const t of await deposits(cashIssuer, inv2, cash, 1, CASH)) prepTxs.push({ p: inv2, tx: t });
  const bLock = await lock(bond, seller, BOND);
  const cLock = await lock(cash, inv2, CASH);
  prepTxs.push({ p: seller, tx: bLock.tx }, { p: inv2, tx: cLock.tx });
  const bLeg = await prepare(bond, seller, bLock.utxo, inv2, BOND);
  const cLeg = await prepare(cash, inv2, cLock.utxo, seller, CASH);
  const atom: Atom = must(await factory.create(cashIssuer.v, [{ contractAddress: bond.zeto.address, callData: bLeg.call }, { contractAddress: cash.zeto.address, callData: cLeg.call }]), "Atom");
  ok(await bond.zeto.using(seller.c).delegateLock(seller.v, { utxos: [bLeg.utxo], delegate: atom.address }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI delegateLock");
  ok(await cash.zeto.using(inv2.c).delegateLock(inv2.v, { utxos: [cLeg.utxo], delegate: atom.address }).waitForReceipt(LONG_POLL_TIMEOUT), "RD delegateLock");
  for (const { p, tx } of prepTxs) await report(p, tx);

  // BI baseline (node4 up): every prep output verified.
  const baseLedger = newLedger(bi.c);
  const prepWant = new Set<string>();
  for (const { tx } of prepTxs) for (const o of await chainOutputs(bi.c, tx.txHash, tx.token.zeto.address)) prepWant.add(o.toString());
  for (const start = Date.now(); [...prepWant].some((c) => !baseLedger.verified.has(c)) && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(2000)) await baseLedger.pollReports();
  const baseMsgs = await biMessages(bi.c);
  row("P1", "baseline before the outage: BI verified every prep output (deposits + locks)", `${prepWant.size}/${prepWant.size} verified, 0 mismatch`,
    `${[...prepWant].filter((c) => baseLedger.verified.has(c)).length}/${prepWant.size} verified, mismatch=${baseLedger.mismatches.length}, ${REPORT_TOPIC} messages at BI=${baseMsgs}`,
    [...prepWant].every((c) => baseLedger.verified.has(c)) && !baseLedger.mismatches.length ? "PASS" : "FAIL");
  if (rows[rows.length - 1].status === "FAIL") throw new Error("baseline failed; not waiting for node4 down");

  const before = { sBond: await balance(bond, seller), iBond: await balance(bond, inv2), sCash: await balance(cash, seller), iCash: await balance(cash, inv2) };
  logger.log(`   balances before: ${JSON.stringify(before, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  // ---- step 2: wait for node4 DOWN (HTTP poll, no kubectl) ----
  logger.log(`\n${now()} WAITING FOR NODE4 DOWN (poll ${nodeConnections[3].clientOptions.url}, up to ${WAIT_DOWN_MS / 60000} min). Lead: delete pod paladin-node4-0 now.`);
  let fails = 0;
  for (const start = Date.now(); fails < 2; await sleep(500)) {
    fails = (await answers(probeClient)) ? 0 : fails + 1;
    if (Date.now() - start > WAIT_DOWN_MS) throw new Error("node4 never went down; nothing was run in the outage");
  }
  const tDown = now();
  logger.log(`${tDown} NODE4 DOWN detected. Running bank-to-bank flows.`);

  // ---- step 3: flows while node4 is down ----
  type Flow = { id: string; what: string; txs: Tx[]; start: string; end: string; downAtEnd: boolean; reports: Report[]; hash: string };
  const flows: Flow[] = [];
  const flow = async (id: string, what: string, run: () => Promise<{ txs: Tx[]; reports: () => Promise<Report[]> }>) => {
    const start = now();
    const { txs, reports } = await run();
    const end = now();
    const downAtEnd = !(await answers(probeClient));
    const sent = await reports(); // must queue, not throw, while BI is down
    flows.push({ id, what, txs, start, end, downAtEnd, reports: sent, hash: txs[0].txHash });
    logger.log(`${end} ${id} receipt ${txs[0].txHash} (start ${start}), node4 still down at receipt: ${downAtEnd}, ${sent.length} report(s) sent`);
  };
  const xfer = (tok: Token, to: Party, what: string) => async () => {
    const tx = txOf(tok, await tok.zeto.using(seller.c).transfer(seller.v, { transfers: [{ to: to.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), what);
    return { txs: [tx], reports: async () => [await report(seller, tx)] };
  };
  const dvp = async () => {
    const exec = must(ok(await atom.using(inv2.c).execute(inv2.v), "Atom execute").transactionHash, "execute txHash");
    const sBond: Tx = { token: bond, txHash: exec };
    const sCash: Tx = { token: cash, txHash: exec };
    return { txs: [sBond, sCash], reports: async () => [await report(seller, sCash, cLeg.states), await report(seller, sBond, bLeg.states), await report(inv2, sCash, cLeg.states)] };
  };
  // DvP execute (node2, no proving) in parallel with the two node1 transfers (proving, sequential).
  await Promise.all([
    flow("F3", "Atom DvP execute: DFABI seller->investor2, RD investor2->seller (bank-to-bank)", dvp),
    (async () => {
      await flow("F1", "RD private transfer bondCustodian@node1 -> investor2@node2", xfer(cash, inv2, "RD transfer"));
      await flow("F2", "DFABI private transfer bondCustodian@node1 -> investor2@node2", xfer(bond, inv2, "DFABI transfer"));
    })(),
  ]);
  const tFlows = now();
  for (const f of flows.sort((a, b) => a.id.localeCompare(b.id))) {
    row(f.id, f.what, "successful receipt on chain while node4 is down", `tx ${f.hash}; ${f.start} -> ${f.end}; node4 down at receipt=${f.downAtEnd}; ${f.reports.length} report(s) queued without error`,
      f.downAtEnd ? "PASS" : "INCONCLUSIVE");
  }
  const downAfter = !(await answers(probeClient));
  const after = { sBond: await balance(bond, seller), iBond: await balance(bond, inv2), sCash: await balance(cash, seller), iCash: await balance(cash, inv2) };
  const delta = { sBond: after.sBond - before.sBond, iBond: after.iBond - before.iBond, sCash: after.sCash - before.sCash, iCash: after.iCash - before.iCash };
  const wantDelta = { sBond: -1n, iBond: 1n + BOND, sCash: -1n + CASH, iCash: 1n };
  const same = (Object.keys(wantDelta) as (keyof typeof wantDelta)[]).every((k) => delta[k] === wantDelta[k]);
  const str = (o: object) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  row("N1", "no fund loss during the outage: exact private balance deltas", str(wantDelta), `${str(delta)} (node4 still down: ${downAfter})`, same ? "PASS" : "FAIL");
  row("N2", "BI's RPC refuses while down; reports are queued by the sending banks, not rejected", "node4 HTTP does not answer; every sendMessage resolved", `node4 answers=${!downAfter}; ${flows.reduce((n, f) => n + f.reports.length, 0)} sendMessage calls resolved`, downAfter && flows.every((f) => f.reports.length > 0) ? "PASS" : "INCONCLUSIVE");
  row("N3", "BI-issued mint while BI is down", "n/a", "not applicable: BI has no issuer or minter role in the Zeto track (verifier only), nothing in Zeto needs BI online except receiving reports", "INFO");

  // ---- step 4: wait for node4 back, fresh BI ledger verifies ----
  logger.log(`\n${now()} flows done (${tDown} -> ${tFlows}). WAITING FOR NODE4 BACK (poll, up to ${WAIT_UP_MS / 60000} min).`);
  let oks = 0;
  for (const start = Date.now(); oks < 3; await sleep(1000)) {
    oks = (await answers(probeClient)) ? oks + 1 : 0;
    if (Date.now() - start > WAIT_UP_MS) throw new Error("node4 did not come back; reports not verified. Outage flows above are valid.");
  }
  const tBack = now();
  const t0 = Date.now();
  logger.log(`${tBack} NODE4 BACK`);
  const biNew = new PaladinClient(nodeConnections[3].clientOptions);
  const ledger = newLedger(biNew);
  const outageWant = new Set<string>();
  for (const f of flows) for (const t of f.txs) for (const o of await chainOutputs(seller.c, t.txHash, t.token.zeto.address)) outageWant.add(o.toString());
  const allWant = new Set([...prepWant, ...outageWant]);
  const missing = () => [...allWant].filter((c) => !ledger.verified.has(c));
  for (const start = Date.now(); missing().length && Date.now() - start < 180_000; await sleep(2000)) await ledger.pollReports().catch(() => 0);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  row("R1", "after node4 is back, a fresh BI ledger (cursor 0) verifies every output of the outage flows", `${outageWant.size}/${outageWant.size} verified`,
    `${[...outageWant].filter((c) => ledger.verified.has(c)).length}/${outageWant.size} verified ${secs}s after node4 answered (back at ${tBack}); duplicates merged=${ledger.duplicates}`,
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
    `BI offline run: node4 down detected ${tDown}, flows done ${tFlows}, node4 back ${tBack}. Tokens DFABI ${bond.zeto.address}, RD ${cash.zeto.address}.`,
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
