/*
 * Zeto-vs-Zeto DvP spike (standalone exploration, option A): DFABI bond = Zeto_Anon, RD cash =
 * Zeto_Anon, both on the Zeto V1 axis (Paladin main + PR #1189, zeto-contracts v0.5.1), settled
 * atomically by an Atom. No Noto. Every leg follows examples/swap (PR #1189) applied to both tokens:
 *   createLock(recipient pinned) -> poll getStateReceipt for the lockId -> prepareSpendLock
 *   -> re-encode spendLock -> Atom op -> delegateLockV1(newSpender = Atom) -> Atom.execute.
 * V1 lock lifecycle replaces V0 lock / prepareTransferLocked / delegateLock(address); reclaim is
 * cancelLock. Zeto_Anon because the lock circuits of KYC tokens were V0-incomplete (README, V0 finding).
 *
 * Full lifecycle on Zeto_Anon, no KYC: I issuance (ERC20 mint -> approve -> deposit, as in
 * examples/private-stablecoin), T 1-unit private transfer per token, the DvP scenarios, and W
 * withdraw back to ERC20 (RD cash-out, DFABI redeem). Fresh tokens per scenario set. DvP scenarios:
 *   S1 happy path, exact balance deltas      P  privacy: node3/node4 (banks, not parties) hold no states
 *   N1 execute with one leg undelegated       N2 tampered bond leg / tampered cash leg (V1: InvalidUnlockHash)
 *   N3 re-execute an executed Atom            N4 third party delegates someone else's lock
 *   F1 abort before delegation: cancelLock before / after prepareSpendLock (V0 finding re-checked)
 *   F2 Atom cancelled after delegation (by a third party), then try to cancelLock both legs
 *   C  4 swaps in parallel (investor2 twice, investor3, investor4)
 * Seller is always bondCustodian@node1 (BI). Buyers are banks on node2-4. Prints a PASS/FAIL line per
 * check; exits 1 on any FAIL.
 *
 * SAFE BY DEFAULT: dry-run unless --execute. Run from this directory (port-forwards up).
 *   npx ts-node spike-zeto-dvp-zz.ts [--execute]
 */
import PaladinClient, { ITransactionReceipt, PaladinVerifier, TransactionType, ZetoFactory, ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, checkDeploy, nodeConnections } from "./src/common";
import { Atom, AtomFactory, newAtomFactory } from "./src/atom";
import { SpendLeg, ZETO_V1, cancelLock, createLock, delegateLock, prepareSpend, tamperedCall } from "./src/zeto-v1";
import atomJson from "./abis/Atom.json";
import erc20Artifact from "./abis/SampleERC20.json";

const logger = console;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOND = 100n;
const CASH = 10n;

type Party = { lookup: string; c: PaladinClient; v: PaladinVerifier };
type Snap = Map<Party, { bond: bigint; cash: bigint }>;
type Leg = SpendLeg;

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
let T: { bond: ZetoInstance; cash: ZetoInstance; bondErc20: string; cashErc20: string };

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

async function publicTx(p: Party, to: string, fn: string, data: Record<string, unknown>, abi: any[]) {
  const id = await p.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, from: p.lookup, to, function: fn, abi, data });
  ok(await p.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT), `${fn} from ${p.lookup}`);
}
const erc20Balance = async (erc20: string, account: string) =>
  BigInt((await cashIssuer.c.ptx.call({ type: TransactionType.PUBLIC, abi: erc20Artifact.abi, function: "balanceOf", to: erc20, from: cashIssuer.lookup, data: { account } }))[0]);

// Issuance as in examples/private-stablecoin (bootstrap-zeto.ts): V1-axis Zeto_Anon + ERC20,
// setERC20, then public mint -> approve -> deposit into the private side.
async function issueToken(issuer: Party) {
  const zeto = await new ZetoFactory(issuer.c, "zeto").newZeto(issuer.v, { ...ZETO_V1 }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(zeto)) throw new Error("Zeto deploy failed");
  const id = await issuer.c.ptx.sendTransaction({
    type: TransactionType.PUBLIC,
    from: issuer.lookup,
    function: "",
    abi: erc20Artifact.abi,
    bytecode: erc20Artifact.bytecode,
    data: { initialOwner: await issuer.v.address() },
  });
  const erc20 = must((await issuer.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT))?.contractAddress, "ERC20 address");
  ok(await zeto!.setERC20(issuer.v, { erc20 }).waitForReceipt(DEFAULT_POLL_TIMEOUT), "setERC20");
  return { zeto: zeto!, erc20 };
}
// One deposit per UTXO wanted, so a holder ends up with `count` UTXOs of `amount` each.
async function seed(issuer: Party, holder: Party, tok: { zeto: ZetoInstance; erc20: string }, count: number, amount: bigint) {
  await publicTx(issuer, tok.erc20, "mint", { to: await holder.v.address(), amount: (amount * BigInt(count)).toString() }, erc20Artifact.abi);
  await publicTx(holder, tok.erc20, "approve", { spender: tok.zeto.address, value: (amount * BigInt(count)).toString() }, erc20Artifact.abi);
  for (let i = 0; i < count; i++) ok(await tok.zeto.using(holder.c).deposit(holder.v, { amount: Number(amount) }).waitForReceipt(LONG_POLL_TIMEOUT), `deposit by ${holder.lookup}`);
}

// Fresh token pair: 5 x 2000 DFABI UTXOs to the seller (so parallel locks need not share one),
// 2 x 5000 RD UTXOs to each buyer.
// setERC20 is a PUBLIC tx to a Zeto contract. On Paladin v1.0.0 a node panicked if its sequencer
// resume ticker saw one before the receipt landed (README "Poison-pill bug", V0 / Paladin v1.0.0), so
// every token set is deployed and linked in one up-front phase, each setERC20 awaited, before any
// other tx. On Paladin main (sequencer resume filters `type = private`) this is OPTIONAL; kept as is.
const issued: { bond: { zeto: ZetoInstance; erc20: string }; cash: { zeto: ZetoInstance; erc20: string } }[] = [];
const TOKEN_SETS = 6; // lifecycle, N2, N4+F1a, F1b, F2, C
async function issueAll() {
  for (let i = 0; i < TOKEN_SETS; i++) issued.push({ bond: await issueToken(bondIssuer), cash: await issueToken(cashIssuer) });
}

async function freshTokens(buyers: Party[]) {
  const { bond, cash } = must(issued.shift(), "pre-issued token set");
  T ={ bond: bond.zeto, cash: cash.zeto, bondErc20: bond.erc20, cashErc20: cash.erc20 };
  logger.log(`   tokens dfabi=${bond.zeto.address} (erc20 ${bond.erc20}) rd=${cash.zeto.address} (erc20 ${cash.erc20})`);
  await Promise.all([seed(bondIssuer, seller, bond, 5, 2000n), ...buyers.map((b) => seed(cashIssuer, b, cash, 2, 5000n))]);
}

// ---- balances (Zeto balanceOf excludes locked UTXOs) ----

async function snap(...ps: Party[]): Promise<Snap> {
  return new Map(
    await Promise.all(
      ps.map(async (p) => {
        const [b, c] = await Promise.all([
          T.bond.using(p.c).balanceOf(p.v, { account: p.lookup }),
          T.cash.using(p.c).balanceOf(p.v, { account: p.lookup }),
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

// ---- one Zeto leg (examples/swap's cash leg, V1), used for both tokens ----

// Reclaim = cancelLock: only the current spender may, so it works before delegation and not after.
const reclaim = (tok: ZetoInstance, owner: Party, lockId: string) => cancelLock(tok, owner, lockId);

async function legOf(tok: ZetoInstance, owner: Party, to: Party, amount: bigint): Promise<Leg> {
  const l = await createLock(tok, owner, to, amount);
  return prepareSpend(tok, owner, l.lockId);
}
const bondLeg = (seller: Party, buyer: Party) => legOf(T.bond, seller, buyer, BOND);
const cashLeg = (buyer: Party, seller: Party) => legOf(T.cash, buyer, seller, CASH);

async function createAtom(bondCall: string, cashCall: string) {
  const ops = [
    { contractAddress: T.bond.address, callData: bondCall },
    { contractAddress: T.cash.address, callData: cashCall },
  ];
  return must(await factory.create(cashIssuer.v, ops), "Atom");
}
async function cancelAtom(atom: Atom, by: Party) {
  const id = await by.c.ptx.sendTransaction({ type: TransactionType.PUBLIC, abi: atomJson.abi, function: "cancel", from: by.lookup, to: atom.address, data: {} });
  return by.c.pollForReceipt(id, DEFAULT_POLL_TIMEOUT);
}
async function delegateBoth(bond: Leg, cash: Leg, buyer: Party, atom: Atom) {
  ok(await delegateLock(T.bond, seller, bond.lockId, atom.address), "DFABI delegateLock");
  ok(await delegateLock(T.cash, buyer, cash.lockId, atom.address), "RD delegateLock");
}

async function swap(seller: Party, buyer: Party) {
  const bond = await bondLeg(seller, buyer);
  const cash = await cashLeg(buyer, seller);
  const atom = await createAtom(bond.call, cash.call);
  await delegateBoth(bond, cash, buyer, atom);
  ok(await atom.using(buyer.c).execute(buyer.v), "Atom execute");
  return atom;
}

// Counts every state of a contract a node holds, across all of the domain's schemas.
async function visibleStates(c: PaladinClient, address: string) {
  let n = 0;
  for (const s of await c.pstate.listSchemas("zeto")) n += (await c.pstate.queryContractStates("zeto", address, s.id, { limit: 1000 } as any, "all")).length;
  return n;
}

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== Zeto-vs-Zeto DvP spike (Zeto V1 lock lifecycle, examples/swap leg on both sides) ===");
  logger.log("Deploys AtomFactory + fresh V1-axis ERC20-backed Zeto_Anon DFABI (bondIssuer@node1 = BI) + RD (cashIssuer@node1 = BI) sets,");
  logger.log(`then runs I T S1 P N1 N3 W N2 N4 F1 F2 C, each swap ${BOND} DFABI for ${CASH} RD. Seller bondCustodian@node1.`);
  if (!execute) {
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to run.");
    return;
  }

  factory = must(await newAtomFactory(cashIssuer.c, cashIssuer.v), "AtomFactory");
  logger.log(`atomFactory=${factory.address}`);
  logger.log(`\n== phase 0: deploy + setERC20 for ${TOKEN_SETS} token sets`);
  await issueAll();
  let executedAtom: Atom | undefined;

  // I, T, S1, P, N1, N3 and W share one token set: the full lifecycle on the same two tokens.
  await scenario("I issuance (ERC20 mint -> approve -> deposit, no KYC)", async () => {
    await freshTokens([inv2]);
    const s = await snap(seller, inv2);
    for (const [name, holder, tok, erc20, priv] of [
      ["DFABI issued to bondCustodian", seller, T.bond, T.bondErc20, must(s.get(seller), "seller").bond],
      ["RD issued to investor2", inv2, T.cash, T.cashErc20, must(s.get(inv2), "inv2").cash],
    ] as const) {
      const [pub, escrow] = await Promise.all([erc20Balance(erc20, await holder.v.address()), erc20Balance(erc20, tok.address)]);
      record(`I ${name}: private 10000, public 0, Zeto escrow 10000`, priv === 10000n && pub === 0n && escrow === 10000n, `private=${priv} public=${pub} escrow=${escrow}`);
    }
  });

  await scenario("T private transfer, 1 unit each", async () => {
    let s0 = await snap(seller, inv2);
    ok(await T.bond.using(seller.c).transfer(seller.v, { transfers: [{ to: inv2.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "DFABI transfer");
    await expectBalances("T DFABI bondCustodian -> investor2", shift(s0, [[seller, -1n, 0n], [inv2, 1n, 0n]]));
    s0 = await snap(seller, inv2);
    ok(await T.cash.using(inv2.c).transfer(inv2.v, { transfers: [{ to: seller.v, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT), "RD transfer");
    await expectBalances("T RD investor2 -> bondCustodian", shift(s0, [[seller, 0n, 1n], [inv2, 0n, -1n]]));
  });

  await scenario("S1 happy path", async () => {
    const s0 = await snap(seller, inv2);
    executedAtom = await swap(seller, inv2);
    await expectBalances("S1 swap moves exact amounts both ways", shift(s0, [[seller, -BOND, CASH], [inv2, BOND, -CASH]]));
  });

  // Same tokens as S1, so only node1 (BI: issuers + seller) and node2 (buyer bank) parties ever touched them.
  await scenario("P privacy", async () => {
    for (const [name, address] of [["DFABI", T.bond.address], ["RD", T.cash.address]]) {
      const n = await Promise.all(nodes.map((c) => visibleStates(c, address)));
      // node1 (seller + issuers) and node2 (buyer) seeing states proves the query itself works.
      record(`P ${name}: the two DvP parties (node1, node2) see states, non-party banks node3/node4 see none`, n[0] > 0 && n[1] > 0 && n[2] === 0 && n[3] === 0, `states node1..4 = ${n.join("/")}`);
    }
  });

  await scenario("N1 one leg not delegated", async () => {
    const s0 = await snap(seller, inv2);
    const bond = await bondLeg(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    const atom = await createAtom(bond.call, cash.call);
    ok(await delegateLock(T.bond, seller, bond.lockId, atom.address), "DFABI delegateLock");
    const locked = await snap(seller, inv2);
    await expectFailure("N1 execute reverts while cash leg is undelegated", () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged("N1 nothing moved", locked);
    ok(await delegateLock(T.cash, inv2, cash.lockId, atom.address), "RD delegateLock");
    await expectSuccess("N1 same Atom executes once the missing leg is delegated", () => atom.using(inv2.c).execute(inv2.v));
    await expectBalances("N1 final balances exact", shift(s0, [[seller, -BOND, CASH], [inv2, BOND, -CASH]]));
  });

  await scenario("N3 replay", async () => {
    const atom = must(executedAtom, "S1 Atom");
    const before = await snap(seller, inv2);
    await expectFailure("N3 executed Atom cannot execute again", () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged("N3 nothing moved", before);
  });

  // Each side withdraws what the swaps gave it: the seller cashes out RD, the buyer redeems DFABI.
  await scenario("W withdraw to ERC20", async () => {
    for (const [name, p, tok, erc20, amount] of [
      ["W RD cash-out by bondCustodian", seller, T.cash, T.cashErc20, CASH],
      ["W DFABI redeem by investor2", inv2, T.bond, T.bondErc20, BOND],
    ] as const) {
      const addr = await p.v.address();
      const read = async () => {
        const [priv, pub, escrow] = await Promise.all([tok.using(p.c).balanceOf(p.v, { account: p.lookup }), erc20Balance(erc20, addr), erc20Balance(erc20, tok.address)]);
        return `private=${priv.totalBalance} public=${pub} escrow=${escrow}`;
      };
      const [priv0, pub0, esc0] = (await read()).match(/\d+/g)!.map(BigInt);
      const want = `private=${priv0 - amount} public=${pub0 + amount} escrow=${esc0 - amount}`;
      ok(await tok.using(p.c).withdraw(p.v, { amount: Number(amount) }).waitForReceipt(LONG_POLL_TIMEOUT), `${name} withdraw`);
      let got = await read();
      for (const start = Date.now(); got !== want && Date.now() - start < LONG_POLL_TIMEOUT; got = await read()) await sleep(2000);
      record(name, got === want, got === want ? got : `got ${got}, want ${want}`);
    }
  });

  await scenario("N2 tampered legs", async () => {
    await freshTokens([inv2]);
    for (const side of ["bond", "cash"] as const) {
      const bond = await bondLeg(seller, inv2);
      const cash = await cashLeg(inv2, seller);
      const atom = await createAtom(side === "bond" ? tamperedCall(bond) : bond.call, side === "cash" ? tamperedCall(cash) : cash.call);
      await delegateBoth(bond, cash, inv2, atom);
      const locked = await snap(seller, inv2);
      await expectFailure(`N2 execute reverts with tampered ${side} output (V1: InvalidUnlockHash, the pinned spendCommitment no longer matches)`, () => atom.using(inv2.c).execute(inv2.v));
      await expectUnchanged(`N2 nothing moved (${side} tamper)`, locked);
    }
  });

  await scenario("N4 + F1a abort before prepare", async () => {
    await freshTokens([inv2]);
    const s0 = await snap(seller, inv2);
    const bondLock = await createLock(T.bond, seller, inv2, BOND);
    const cashLock = await createLock(T.cash, inv2, seller, CASH);
    await expectFailure("N4 investor3 cannot delegate bondCustodian's lock (not the spender)", async () => delegateLock(T.bond, inv3, bondLock.lockId, await inv3.v.address()));
    await expectFailure("N4 investor3 cannot delegate investor2's lock (not the spender)", async () => delegateLock(T.cash, inv3, cashLock.lockId, await inv3.v.address()));
    await expectSuccess("F1a seller reclaims the DFABI lock (cancelLock)", () => reclaim(T.bond, seller, bondLock.lockId));
    await expectSuccess("F1a buyer reclaims the RD lock (cancelLock)", () => reclaim(T.cash, inv2, cashLock.lockId));
    await expectBalances("F1a both back to pre-swap balances", s0);
  });

  // V0 finding "a locked UTXO cannot be reclaimed after prepareTransferLocked" (PD210134) came from the V0
  // transferLocked handler reading its inputs with FindAvailableStates. The V1 spendLock/cancelLock handlers
  // read the locked coins with GetStatesByID (domains/zeto/internal/zeto/fungible/states.go:234, "regardless
  // of confirmation/spend status"), so the mechanism is gone. Whether the sequencer still reserves the locked
  // coins for the prepared tx is not known from source: this test RECORDS the outcome, it does not assert one.
  await scenario("F1b abort after prepareSpendLock (V0 finding re-check)", async () => {
    await freshTokens([inv2]);
    const s0 = await snap(seller, inv2);
    const bond = await bondLeg(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    const why = await Promise.all([failure(() => reclaim(T.bond, seller, bond.lockId)), failure(() => reclaim(T.cash, inv2, cash.lockId))]);
    const reclaimed = why.map((w) => w === undefined);
    logger.log(`   F1b V1 cancelLock after prepareSpendLock: DFABI ${reclaimed[0] ? "SUCCEEDED" : `failed (${why[0]})`}; RD ${reclaimed[1] ? "SUCCEEDED" : `failed (${why[1]})`}`);
    record("F1b V1 outcome recorded (V0 finding PD210134 re-checked)", true, reclaimed.every((r) => r) ? "V0 finding does NOT apply: reclaim works after prepare" : reclaimed.some((r) => r) ? "mixed outcome" : "V0 finding STILL applies: reclaim fails after prepare");
    const want = shift(s0, [[seller, reclaimed[0] ? 0n : -BOND, 0n], [inv2, 0n, reclaimed[1] ? 0n : -CASH]]);
    await expectBalances("F1b balances match the recorded outcome", want);
    if (reclaimed.every((r) => r)) await expectFailure("F1b the prepared spendLock can no longer be executed (lock gone)", async () => { const atom = await createAtom(bond.call, cash.call); return atom.using(inv2.c).execute(inv2.v); });
  });

  await scenario("F2 Atom cancelled after delegation", async () => {
    await freshTokens([inv2]);
    const bond = await bondLeg(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    const atom = await createAtom(bond.call, cash.call);
    await delegateBoth(bond, cash, inv2, atom);
    const locked = await snap(seller, inv2);
    // Upstream Atom.cancel() has no access control: anyone may cancel a pending Atom.
    await expectSuccess("F2 third party (investor4) can cancel the pending Atom", () => cancelAtom(atom, inv4));
    await expectFailure("F2 cancelled Atom cannot execute", () => atom.using(inv2.c).execute(inv2.v));
    // The Atom is now the lock spender for both legs and has no way to release them: cancelLock is spender-only.
    await expectFailure("F2 seller cannot cancelLock the DFABI lock delegated to the cancelled Atom", () => reclaim(T.bond, seller, bond.lockId));
    await expectFailure("F2 buyer cannot cancelLock the RD lock delegated to the cancelled Atom", () => reclaim(T.cash, inv2, cash.lockId));
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
  logger.log(`Zeto-vs-Zeto DvP spike: ${failed.length ? "FAIL" : "PASS"}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  logger.error("Zeto-vs-Zeto DvP spike: FAIL", err);
  process.exit(1);
});
