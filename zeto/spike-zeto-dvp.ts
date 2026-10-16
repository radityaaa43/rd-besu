/*
 * Zeto DvP spike (phase 2 exploration, standalone; not wired into the Noto+Pente backend).
 * Follows Paladin's official examples/swap + doc-site tutorials/atomic-swap.md step for step:
 * Noto asset (DFABI bond) vs Zeto_Anon cash (RD), settled atomically by an Atom.
 * Noto runs in basic notary mode, as in the upstream domains/integration-test/pvp_test.go
 * TestNotoForZeto. Zeto_Anon is used because upstream lock/transferLocked only supports ANON
 * (zeto_fungible_test.go:264 at v1.0.0), and the official image ships no KYC transferLocked circuit.
 *
 * Deploys fresh tokens (several sets, so one scenario's leftovers cannot affect another);
 * the live RD/DFABI tokens are never touched. Scenarios:
 *   S1 happy path, exact balance deltas      P  privacy: node3/node4 hold no states of the swap
 *   N1 execute with one leg undelegated       N2 tampered cash leg / tampered bond leg
 *   N3 re-execute an executed Atom            N4 third party re-delegates someone else's lock
 *   F1 abort before delegation: reclaim before / after prepareTransferLocked
 *   F2 Atom cancelled after delegation (by a third party), then try to reclaim
 *   C  4 swaps in parallel (investor2 twice, investor3, investor4)
 * Seller is always bondCustodian@node1. Prints a PASS/FAIL line per check; exits 1 on any FAIL.
 *
 * SAFE BY DEFAULT: dry-run unless --execute. Run from this directory (port-forwards up).
 *   npx ts-node spike-zeto-dvp.ts [--execute]
 */
import PaladinClient, {
  INotoDomainReceipt,
  ITransactionReceipt,
  NotoFactory,
  NotoInstance,
  PaladinVerifier,
  TransactionType,
  ZetoFactory,
  ZetoInstance,
} from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, checkDeploy, nodeConnections } from "./src/common";
import { Atom, AtomFactory, newAtomFactory } from "./src/atom";
import atomJson from "./abis/Atom.json";
import notoJson from "./abis/INoto_V1.json";

const logger = console;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOND = 100n;
const CASH = 10n;

type Party = { lookup: string; c: PaladinClient; v: PaladinVerifier };
type Snap = Map<Party, { bond: bigint; cash: bigint }>;

const nodes = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
const party = (lookup: string): Party => {
  const c = nodes[Number(lookup.split("@node")[1]) - 1];
  return { lookup, c, v: c.getVerifiers(lookup)[0] };
};
const cashIssuer = party("cashIssuer@node1");
const bondIssuer = party("bondIssuer@node1");
const seller = party("bondCustodian@node1");
const [inv2, inv3, inv4] = ["investor2@node2", "investor3@node3", "investor4@node4"].map(party);
let factory: AtomFactory;
let T: { rd: ZetoInstance; dfabi: NotoInstance };

function must<V>(value: V | undefined | null, what: string): V {
  if (value === undefined || value === null) throw new Error(`${what} missing`);
  return value;
}

function ok(r: ITransactionReceipt | undefined, what: string) {
  if (r?.success !== true) throw new Error(`${what} failed: ${r?.failureMessage ?? "no receipt"}`);
}

// undefined = the tx succeeded; otherwise why it did not.
async function failure(send: () => Promise<ITransactionReceipt | undefined>): Promise<string | undefined> {
  try {
    const r = await send();
    return r?.success === true ? undefined : r?.failureMessage ?? "no receipt";
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

const results: { name: string; pass: boolean }[] = [];
function record(name: string, pass: boolean, detail = "") {
  results.push({ name, pass });
  logger.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail.slice(0, 200)}` : ""}`);
}
const expectFailure = async (name: string, send: () => Promise<ITransactionReceipt | undefined>) => {
  const why = await failure(send);
  record(name, why !== undefined, why ?? "unexpectedly succeeded");
};
const expectSuccess = async (name: string, send: () => Promise<ITransactionReceipt | undefined>) => {
  const why = await failure(send);
  record(name, why === undefined, why);
};

async function scenario(name: string, run: () => Promise<void>) {
  logger.log(`\n== ${name}`);
  try {
    await run();
  } catch (e) {
    record(`${name} (aborted)`, false, String((e as Error)?.message ?? e));
  }
}

// Fresh token pair: 10000 DFABI to the seller, 2 x 5000 RD UTXOs to each buyer.
async function freshTokens(buyers: Party[]) {
  const rd = await new ZetoFactory(cashIssuer.c, "zeto").newZeto(cashIssuer.v, { tokenName: "Zeto_Anon" }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  const dfabi = await new NotoFactory(bondIssuer.c, "noto")
    .newNoto(bondIssuer.v, { name: "DFABI", symbol: "DFABI", notary: bondIssuer.v, notaryMode: "basic" })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(rd) || !checkDeploy(dfabi)) throw new Error("token deploy failed");
  T = { rd: rd!, dfabi: dfabi! };
  logger.log(`   tokens rd=${rd!.address} dfabi=${dfabi!.address}`);
  ok(await T.dfabi.mint(bondIssuer.v, { to: seller.v, amount: "10000", data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI mint");
  const mints = buyers.flatMap((b) => [b.v, b.v]).map((to) => ({ to, amount: 5000, data: "0x" }));
  ok(await T.rd.mint(cashIssuer.v, { mints }).waitForReceipt(LONG_POLL_TIMEOUT), "RD mint");
}

// ---- balances ----

async function snap(...ps: Party[]): Promise<Snap> {
  return new Map(
    await Promise.all(
      ps.map(async (p) => {
        const [b, c] = await Promise.all([
          T.dfabi.using(p.c).balanceOf(p.v, { account: p.lookup }),
          T.rd.using(p.c).balanceOf(p.v, { account: p.lookup }),
        ]);
        return [p, { bond: BigInt(b.totalBalance), cash: BigInt(c.totalBalance) }] as const;
      })
    )
  );
}
const fmt = (s: Snap) => [...s].map(([p, b]) => `${p.lookup}=${b.bond}/${b.cash}`).join(" ");
function shift(s: Snap, deltas: [Party, bigint, bigint][]): Snap {
  const out: Snap = new Map([...s].map(([p, b]) => [p, { ...b }]));
  for (const [p, bond, cash] of deltas) {
    const b = must(out.get(p), p.lookup);
    b.bond += bond;
    b.cash += cash;
  }
  return out;
}
// Balances lag receipts (examples/swap polls too): poll until they match.
async function expectBalances(name: string, want: Snap) {
  let got = await snap(...want.keys());
  for (const start = Date.now(); fmt(got) !== fmt(want) && Date.now() - start < LONG_POLL_TIMEOUT; got = await snap(...want.keys())) await sleep(2000);
  record(name, fmt(got) === fmt(want), fmt(got) === fmt(want) ? fmt(got) : `got ${fmt(got)}, want ${fmt(want)}`);
}
// After a failed tx: give any stray effect time to land, then require no change at all.
async function expectUnchanged(name: string, before: Snap) {
  await sleep(5000);
  const got = await snap(...before.keys());
  record(name, fmt(got) === fmt(before), fmt(got) === fmt(before) ? fmt(got) : `got ${fmt(got)}, want ${fmt(before)}`);
}

// ---- swap legs (same calls as examples/swap) ----

async function lockInfo(p: Party, r: ITransactionReceipt | undefined) {
  return ((await p.c.ptx.getTransactionReceiptFull(must(r, "receipt").id))?.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo;
}

async function bondLeg(seller: Party, buyer: Party) {
  const noto = T.dfabi.using(seller.c);
  let r = await noto.lock(seller.v, { amount: BOND.toString(), data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT);
  ok(r, "DFABI lock");
  const lockId = must((await lockInfo(seller, r))?.lockId, "lockId");
  r = await noto
    .prepareUnlock(seller.v, { lockId, from: seller.v, recipients: [{ to: buyer.v, amount: BOND.toString() }], unlockData: "0x", data: "0x" })
    .waitForReceipt(LONG_POLL_TIMEOUT);
  ok(r, "DFABI prepareUnlock");
  const info = await lockInfo(seller, r);
  return { lockId, unlockCall: must(info?.unlockCall, "unlockCall"), cancelCall: must(info?.cancelCall, "cancelCall") };
}

async function lockCash(buyer: Party, timeout = LONG_POLL_TIMEOUT) {
  const r = await T.rd.using(buyer.c).lock(buyer.v, { amount: Number(CASH), delegate: await buyer.v.address() }).waitForReceipt(timeout);
  ok(r, "RD lock");
  let utxo: string | undefined;
  for (const start = Date.now(); !utxo && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(1000)) {
    utxo = (await buyer.c.ptx.getStateReceipt(must(r, "receipt").id))?.confirmed?.find((s) => s.data["locked"])?.id;
  }
  return must(utxo, "locked state");
}

async function cashLeg(buyer: Party, seller: Party) {
  const utxo = await lockCash(buyer);
  const txId = await T.rd.using(buyer.c).prepareTransferLocked(buyer.v, {
    lockedInputs: [utxo],
    delegate: buyer.lookup,
    transfers: [{ to: seller.v, amount: Number(CASH), data: "0x" }],
  }).id;
  const prepared = must(await buyer.c.pollForPreparedTransaction(txId, LONG_POLL_TIMEOUT), "prepared transferLocked");
  // Same re-encode as examples/swap encodeZetoTransfer (upstream TODO: eliminate the need for this call).
  const abi = must(await buyer.c.ptx.getStoredABI(prepared.transaction.abiReference ?? ""), "stored ABI").abi;
  const d = prepared.transaction.data as any;
  const encode = (outputs: string[]) => new ethers.Interface(abi).encodeFunctionData("transferLocked", [d.inputs, outputs, d.proof, d.data]);
  return { utxo, call: encode(d.outputs), encode, outputs: d.outputs as string[] };
}

const delegateBond = (seller: Party, lockId: string, to: string) =>
  T.dfabi.using(seller.c).delegateLock(seller.v, { lockId, delegate: to, data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT);
const delegateCash = (p: Party, utxo: string, to: string) =>
  T.rd.using(p.c).delegateLock(p.v, { utxos: [utxo], delegate: to }).waitForReceipt(LONG_POLL_TIMEOUT);
// Zeto has no unlock in Paladin: the owner (still the lock delegate) transferLocked's back to itself.
const reclaimCash = (buyer: Party, utxo: string) =>
  T.rd
    .using(buyer.c)
    .transferLocked(buyer.v, { lockedInputs: [utxo], delegate: buyer.lookup, transfers: [{ to: buyer.v, amount: Number(CASH), data: "0x" }] })
    .waitForReceipt(LONG_POLL_TIMEOUT);
// After prepareUnlock only the prepared spend or cancel can run (Noto.sol spendTxId). Cancel is
// the lock spender's cancelLock (noto.md lock state machine); in basic mode the undelegated
// spender is the notary, so the notary submits the prepared cancelCall.
const notoIface = new ethers.Interface(notoJson.abi);
async function reclaimBond(cancelCall: string) {
  const tx = must(notoIface.parseTransaction({ data: cancelCall }), "cancelCall decode");
  const data = Object.fromEntries(tx.fragment.inputs.map((input, i) => [input.name, tx.args[i]]));
  const id = await bondIssuer.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, abi: notoJson.abi, function: tx.name, from: bondIssuer.lookup, to: T.dfabi.address, data });
  return bondIssuer.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT);
}

async function createAtom(bondCall: string, cashCall: string) {
  const ops = [
    { contractAddress: T.dfabi.address, callData: bondCall },
    { contractAddress: T.rd.address, callData: cashCall },
  ];
  return must(await factory.create(cashIssuer.v, ops), "Atom");
}
async function cancelAtom(atom: Atom, by: Party) {
  const id = await by.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, abi: atomJson.abi, function: "cancel", from: by.lookup, to: atom.address, data: {} });
  return by.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT);
}

async function swap(seller: Party, buyer: Party) {
  const bond = await bondLeg(seller, buyer);
  const cash = await cashLeg(buyer, seller);
  const atom = await createAtom(bond.unlockCall, cash.call);
  ok(await delegateBond(seller, bond.lockId, atom.address), "DFABI delegateLock");
  ok(await delegateCash(buyer, cash.utxo, atom.address), "RD delegateLock");
  ok(await atom.using(buyer.c).execute(buyer.v), "Atom execute");
  return atom;
}

// Counts every state of a contract a node holds, across all of the domain's schemas.
async function visibleStates(c: PaladinClient, domain: string, address: string) {
  let n = 0;
  for (const s of await c.pstate.listSchemas(domain)) n += (await c.pstate.queryContractStates(domain, address, s.id, { limit: 1000 } as any, "all")).length;
  return n;
}

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== Zeto DvP spike (template: examples/swap) ===");
  logger.log("Deploys AtomFactory + fresh Zeto_Anon RD (cashIssuer@node1) + basic Noto DFABI (bondIssuer@node1) sets,");
  logger.log(`then runs S1 P N1 N2 N3 N4 F1 F2 C, each swap ${BOND} DFABI for ${CASH} RD. Seller bondCustodian@node1.`);
  if (!execute) {
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to run.");
    return;
  }

  factory = must(await newAtomFactory(cashIssuer.c, cashIssuer.v), "AtomFactory");
  logger.log(`atomFactory=${factory.address}`);
  let executedAtom: Atom | undefined;

  await scenario("S1 happy path", async () => {
    await freshTokens([inv2]);
    const s0 = await snap(seller, inv2);
    executedAtom = await swap(seller, inv2);
    await expectBalances("S1 swap moves exact amounts both ways", shift(s0, [[seller, -BOND, CASH], [inv2, BOND, -CASH]]));
  });

  // Same tokens as S1, which only node1/node2 parties ever touched.
  await scenario("P privacy", async () => {
    for (const [domain, address] of [["noto", T.dfabi.address], ["zeto", T.rd.address]]) {
      const n = await Promise.all(nodes.map((c) => visibleStates(c, domain, address)));
      // node1 (seller + notary) and node2 (buyer) seeing states proves the query itself works.
      record(`P ${domain}: parties see states, node3/node4 see none`, n[0] > 0 && n[1] > 0 && n[2] === 0 && n[3] === 0, `states node1..4 = ${n.join("/")}`);
    }
  });

  await scenario("N1 one leg not delegated", async () => {
    const s0 = await snap(seller, inv2);
    const bond = await bondLeg(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    const atom = await createAtom(bond.unlockCall, cash.call);
    ok(await delegateBond(seller, bond.lockId, atom.address), "DFABI delegateLock");
    const locked = await snap(seller, inv2);
    await expectFailure("N1 execute reverts while cash leg is undelegated", () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged("N1 nothing moved", locked);
    ok(await delegateCash(inv2, cash.utxo, atom.address), "RD delegateLock");
    await expectSuccess("N1 same Atom executes once the missing leg is delegated", () => atom.using(inv2.c).execute(inv2.v));
    await expectBalances("N1 final balances exact", shift(s0, [[seller, -BOND, CASH], [inv2, BOND, -CASH]]));
  });

  await scenario("N3 replay", async () => {
    const atom = must(executedAtom, "S1 Atom");
    const before = await snap(seller, inv2);
    await expectFailure("N3 executed Atom cannot execute again", () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged("N3 nothing moved", before);
  });

  await scenario("N2 tampered legs", async () => {
    await freshTokens([inv2]);
    // Cash leg: change one output commitment, so the proof no longer matches.
    let bond = await bondLeg(seller, inv2);
    let cash = await cashLeg(inv2, seller);
    const outputs = [...cash.outputs];
    outputs[0] = (BigInt(outputs[0]) + 1n).toString();
    let atom = await createAtom(bond.unlockCall, cash.encode(outputs));
    ok(await delegateBond(seller, bond.lockId, atom.address), "DFABI delegateLock");
    ok(await delegateCash(inv2, cash.utxo, atom.address), "RD delegateLock");
    let locked = await snap(seller, inv2);
    await expectFailure("N2 execute reverts with tampered cash output", () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged("N2 nothing moved (cash tamper)", locked);

    // Bond leg: flip one byte of spendArgs, so it no longer matches what prepareUnlock committed.
    bond = await bondLeg(seller, inv2);
    cash = await cashLeg(inv2, seller);
    const spend = must(notoIface.parseTransaction({ data: bond.unlockCall }), "spendLock decode");
    const args = ethers.getBytes(spend.args[1]);
    args[31] ^= 1;
    atom = await createAtom(notoIface.encodeFunctionData("spendLock", [spend.args[0], args, spend.args[2]]), cash.call);
    ok(await delegateBond(seller, bond.lockId, atom.address), "DFABI delegateLock");
    ok(await delegateCash(inv2, cash.utxo, atom.address), "RD delegateLock");
    locked = await snap(seller, inv2);
    await expectFailure("N2 execute reverts with tampered bond spendArgs", () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged("N2 nothing moved (bond tamper)", locked);
  });

  await scenario("N4 + F1a abort before prepare", async () => {
    await freshTokens([inv2]);
    const s0 = await snap(seller, inv2);
    const bond = await bondLeg(seller, inv2);
    const utxo = await lockCash(inv2);
    await expectFailure("N4 investor3 cannot delegate investor2's locked RD", async () => delegateCash(inv3, utxo, await inv3.v.address()));
    await expectFailure("N4 investor3 cannot delegate bondCustodian's DFABI lock", async () =>
      T.dfabi.using(inv3.c).delegateLock(inv3.v, { lockId: bond.lockId, delegate: await inv3.v.address(), data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT)
    );
    await expectSuccess("F1a buyer reclaims locked RD (transferLocked to self)", () => reclaimCash(inv2, utxo));
    await expectFailure("F1a seller itself cannot send the cancelCall (not the lock spender)", async () => {
      const tx = must(notoIface.parseTransaction({ data: bond.cancelCall }), "cancelCall decode");
      const data = Object.fromEntries(tx.fragment.inputs.map((input, i) => [input.name, tx.args[i]]));
      const id = await seller.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, abi: notoJson.abi, function: tx.name, from: seller.lookup, to: T.dfabi.address, data });
      return seller.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT);
    });
    await expectSuccess("F1a notary cancels the DFABI lock via the prepared cancelCall", () => reclaimBond(bond.cancelCall));
    await expectBalances("F1a both back to pre-swap balances", s0);
  });

  await scenario("F1b abort after prepareTransferLocked", async () => {
    await freshTokens([inv2]);
    const s0 = await snap(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    // The prepared tx holds the locked UTXO, so the domain no longer sees it as available.
    await expectFailure("F1b buyer cannot reclaim RD once transferLocked is prepared", () => reclaimCash(inv2, cash.utxo));
    await expectSuccess("F1b buyer's next RD lock still goes through", () => lockCash(inv2, DEFAULT_POLL_TIMEOUT * 2).then(() => ({ success: true }) as any));
    await expectBalances("F1b only the 2 locks are held back", shift(s0, [[inv2, 0n, -2n * CASH]]));
  });

  await scenario("F2 Atom cancelled after delegation", async () => {
    await freshTokens([inv2]);
    const bond = await bondLeg(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    const atom = await createAtom(bond.unlockCall, cash.call);
    ok(await delegateBond(seller, bond.lockId, atom.address), "DFABI delegateLock");
    ok(await delegateCash(inv2, cash.utxo, atom.address), "RD delegateLock");
    const locked = await snap(seller, inv2);
    // Upstream Atom.cancel() has no access control: anyone may cancel a pending Atom.
    await expectSuccess("F2 third party (investor4) can cancel the pending Atom", () => cancelAtom(atom, inv4));
    await expectFailure("F2 cancelled Atom cannot execute", () => atom.using(inv2.c).execute(inv2.v));
    // The Atom is now the lock spender/delegate for both legs and has no way to release them.
    await expectFailure("F2 notary cannot cancel DFABI delegated to the cancelled Atom", () => reclaimBond(bond.cancelCall));
    await expectFailure("F2 buyer cannot reclaim RD delegated to the cancelled Atom", () => reclaimCash(inv2, cash.utxo));
    await expectUnchanged("F2 locked funds stay locked", locked);
  });

  await scenario("C 4 parallel swaps", async () => {
    await freshTokens([inv2, inv3, inv4]);
    const buyers = [inv2, inv2, inv3, inv4];
    const s0 = await snap(seller, inv2, inv3, inv4);
    const t0 = Date.now();
    const settled = await Promise.allSettled(buyers.map((b) => swap(seller, b)));
    const done = buyers.filter((_, i) => settled[i].status === "fulfilled");
    settled.forEach((s, i) => s.status === "rejected" && logger.log(`   swap ${i} (${buyers[i].lookup}) failed: ${String(s.reason?.message ?? s.reason).slice(0, 200)}`));
    record("C all 4 parallel swaps settle", done.length === 4, `${done.length}/4 in ${Math.round((Date.now() - t0) / 1000)}s`);
    const n = BigInt(done.length);
    await expectBalances(
      "C balances match the swaps that settled",
      shift(s0, [[seller, -BOND * n, CASH * n], ...done.map((b) => [b, BOND, -CASH] as [Party, bigint, bigint])])
    );
  });

  const failed = results.filter((r) => !r.pass);
  logger.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((r) => logger.log(`  FAIL ${r.name}`));
  logger.log(`Zeto DvP spike: ${failed.length ? "FAIL" : "PASS"}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  logger.error("Zeto DvP spike: FAIL", err);
  process.exit(1);
});
