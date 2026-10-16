/*
 * Zeto-vs-Zeto DvP spike (standalone exploration, option A): DFABI bond = Zeto_Anon, RD cash =
 * Zeto_Anon, settled atomically by an Atom. No Noto. Upstream has no Zeto-for-Zeto example
 * (pvp_test.go at v1.0.0 has TestNotoForNoto, TestNotoForNotoWithHooks, TestNotoForZeto only),
 * so every leg here is the Zeto leg of examples/swap at v1.0.0, applied to both tokens:
 *   lock(amount, delegate = own address) -> poll getStateReceipt for the locked UTXO
 *   -> prepareTransferLocked -> re-encode transferLocked -> Atom op -> delegateLock(Atom) -> execute.
 * Zeto_Anon because lock/transferLocked only works for ANON (zeto_fungible_test.go:264 at v1.0.0).
 *
 * Full lifecycle on Zeto_Anon, no KYC: I issuance (ERC20 mint -> approve -> deposit, as in
 * examples/private-stablecoin), T 1-unit private transfer per token, the DvP scenarios, and W
 * withdraw back to ERC20 (RD cash-out, DFABI redeem). Fresh tokens per scenario set; the live
 * KYC RD/DFABI tokens in out/ are never touched. DvP scenarios:
 *   S1 happy path, exact balance deltas      P  privacy: node3/node4 hold no states of the swap
 *   N1 execute with one leg undelegated       N2 tampered bond leg / tampered cash leg
 *   N3 re-execute an executed Atom            N4 third party re-delegates someone else's lock
 *   F1 abort before delegation, both legs: reclaim before / after prepareTransferLocked
 *   F2 Atom cancelled after delegation (by a third party), then try to reclaim both legs
 *   C  4 swaps in parallel (investor2 twice, investor3, investor4)
 * Seller is always bondCustodian@node1. Prints a PASS/FAIL line per check; exits 1 on any FAIL.
 *
 * SAFE BY DEFAULT: dry-run unless --execute. Run from this directory (port-forwards up).
 *   npx ts-node spike-zeto-dvp-zz.ts [--execute]
 */
import PaladinClient, { ITransactionReceipt, PaladinVerifier, TransactionType, ZetoFactory, ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, checkDeploy, nodeConnections } from "./src/common";
import { Atom, AtomFactory, newAtomFactory } from "./src/atom";
import atomJson from "./abis/Atom.json";
import erc20Artifact from "./abis/SampleERC20.json";

const logger = console;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOND = 100n;
const CASH = 10n;

type Party = { lookup: string; c: PaladinClient; v: PaladinVerifier };
type Snap = Map<Party, { bond: bigint; cash: bigint }>;
type Leg = { utxo: string; call: string; encode: (outputs: string[]) => string; outputs: string[] };

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

// Issuance as in examples/private-stablecoin (bootstrap-zeto.ts minus KYC): Zeto_Anon + ERC20,
// setERC20, then public mint -> approve -> deposit into the private side.
async function issueToken(issuer: Party) {
  const zeto = await new ZetoFactory(issuer.c, "zeto").newZeto(issuer.v, { tokenName: "Zeto_Anon" }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
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
// setERC20 is a PUBLIC tx to a Zeto contract. On v1.0.0 a node panics if its sequencer resume
// ticker sees one before the receipt lands (README "Poison-pill bug"), so every token set is
// deployed and linked in one up-front phase, each setERC20 awaited, before any other tx.
// ponytail: shrinks the window only; the real fix is upstream.
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

// ---- one Zeto leg (examples/swap's cash leg), used for both tokens ----

async function lock(tok: ZetoInstance, owner: Party, amount: bigint, timeout = LONG_POLL_TIMEOUT) {
  const r = await tok.using(owner.c).lock(owner.v, { amount: Number(amount), delegate: await owner.v.address() }).waitForReceipt(timeout);
  ok(r, "lock");
  let utxo: string | undefined;
  for (const start = Date.now(); !utxo && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(1000)) {
    utxo = (await owner.c.ptx.getStateReceipt(must(r, "receipt").id))?.confirmed?.find((s) => s.data["locked"])?.id;
  }
  return must(utxo, "locked state");
}

async function prepare(tok: ZetoInstance, owner: Party, utxo: string, to: Party, amount: bigint): Promise<Leg> {
  const txId = await tok.using(owner.c).prepareTransferLocked(owner.v, {
    lockedInputs: [utxo],
    delegate: owner.lookup,
    transfers: [{ to: to.v, amount: Number(amount), data: "0x" }],
  }).id;
  const prepared = must(await owner.c.pollForPreparedTransaction(txId, LONG_POLL_TIMEOUT), "prepared transferLocked");
  // Same re-encode as examples/swap encodeZetoTransfer (upstream TODO: eliminate the need for this call).
  const abi = must(await owner.c.ptx.getStoredABI(prepared.transaction.abiReference ?? ""), "stored ABI").abi;
  const d = prepared.transaction.data as any;
  const encode = (outputs: string[]) => new ethers.Interface(abi).encodeFunctionData("transferLocked", [d.inputs, outputs, d.proof, d.data]);
  return { utxo, call: encode(d.outputs), encode, outputs: d.outputs as string[] };
}

const bondLeg = async (seller: Party, buyer: Party) => prepare(T.bond, seller, await lock(T.bond, seller, BOND), buyer, BOND);
const cashLeg = async (buyer: Party, seller: Party) => prepare(T.cash, buyer, await lock(T.cash, buyer, CASH), seller, CASH);

const delegate = (tok: ZetoInstance, p: Party, utxo: string, to: string) =>
  tok.using(p.c).delegateLock(p.v, { utxos: [utxo], delegate: to }).waitForReceipt(LONG_POLL_TIMEOUT);
// Zeto has no unlock in Paladin: the owner (still the lock delegate) transferLocked's back to itself.
const reclaim = (tok: ZetoInstance, owner: Party, utxo: string, amount: bigint) =>
  tok
    .using(owner.c)
    .transferLocked(owner.v, { lockedInputs: [utxo], delegate: owner.lookup, transfers: [{ to: owner.v, amount: Number(amount), data: "0x" }] })
    .waitForReceipt(LONG_POLL_TIMEOUT);
// Tamper one output commitment, so the leg's proof no longer matches.
const tampered = (leg: Leg) => leg.encode([(BigInt(leg.outputs[0]) + 1n).toString(), ...leg.outputs.slice(1)]);

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
  ok(await delegate(T.bond, seller, bond.utxo, atom.address), "DFABI delegateLock");
  ok(await delegate(T.cash, buyer, cash.utxo, atom.address), "RD delegateLock");
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
  logger.log("=== Zeto-vs-Zeto DvP spike (examples/swap Zeto leg on both sides) ===");
  logger.log("Deploys AtomFactory + fresh ERC20-backed Zeto_Anon DFABI (bondIssuer@node1) + RD (cashIssuer@node1) sets,");
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

  // Same tokens as S1, so only node1/node2 parties ever touched them.
  await scenario("P privacy", async () => {
    for (const [name, address] of [["DFABI", T.bond.address], ["RD", T.cash.address]]) {
      const n = await Promise.all(nodes.map((c) => visibleStates(c, address)));
      // node1 (seller + issuers) and node2 (buyer) seeing states proves the query itself works.
      record(`P ${name}: parties see states, node3/node4 see none`, n[0] > 0 && n[1] > 0 && n[2] === 0 && n[3] === 0, `states node1..4 = ${n.join("/")}`);
    }
  });

  await scenario("N1 one leg not delegated", async () => {
    const s0 = await snap(seller, inv2);
    const bond = await bondLeg(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    const atom = await createAtom(bond.call, cash.call);
    ok(await delegate(T.bond, seller, bond.utxo, atom.address), "DFABI delegateLock");
    const locked = await snap(seller, inv2);
    await expectFailure("N1 execute reverts while cash leg is undelegated", () => atom.using(inv2.c).execute(inv2.v));
    await expectUnchanged("N1 nothing moved", locked);
    ok(await delegate(T.cash, inv2, cash.utxo, atom.address), "RD delegateLock");
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
      const atom = await createAtom(side === "bond" ? tampered(bond) : bond.call, side === "cash" ? tampered(cash) : cash.call);
      await delegateBoth(bond, cash, inv2, atom);
      const locked = await snap(seller, inv2);
      await expectFailure(`N2 execute reverts with tampered ${side} output`, () => atom.using(inv2.c).execute(inv2.v));
      await expectUnchanged(`N2 nothing moved (${side} tamper)`, locked);
    }
  });

  await scenario("N4 + F1a abort before prepare", async () => {
    await freshTokens([inv2]);
    const s0 = await snap(seller, inv2);
    const bondUtxo = await lock(T.bond, seller, BOND);
    const cashUtxo = await lock(T.cash, inv2, CASH);
    await expectFailure("N4 investor3 cannot delegate bondCustodian's locked DFABI", async () => delegate(T.bond, inv3, bondUtxo, await inv3.v.address()));
    await expectFailure("N4 investor3 cannot delegate investor2's locked RD", async () => delegate(T.cash, inv3, cashUtxo, await inv3.v.address()));
    await expectSuccess("F1a seller reclaims locked DFABI (transferLocked to self)", () => reclaim(T.bond, seller, bondUtxo, BOND));
    await expectSuccess("F1a buyer reclaims locked RD (transferLocked to self)", () => reclaim(T.cash, inv2, cashUtxo, CASH));
    await expectBalances("F1a both back to pre-swap balances", s0);
  });

  await scenario("F1b abort after prepareTransferLocked", async () => {
    await freshTokens([inv2]);
    const s0 = await snap(seller, inv2);
    const bond = await bondLeg(seller, inv2);
    const cash = await cashLeg(inv2, seller);
    // The prepared tx holds the locked UTXO, so the domain no longer sees it as available.
    await expectFailure("F1b seller cannot reclaim DFABI once transferLocked is prepared", () => reclaim(T.bond, seller, bond.utxo, BOND));
    await expectFailure("F1b buyer cannot reclaim RD once transferLocked is prepared", () => reclaim(T.cash, inv2, cash.utxo, CASH));
    const relock = (tok: ZetoInstance, p: Party, amount: bigint) => () => lock(tok, p, amount, DEFAULT_POLL_TIMEOUT * 2).then(() => ({ success: true }) as any);
    await expectSuccess("F1b seller's next DFABI lock still goes through", relock(T.bond, seller, BOND));
    await expectSuccess("F1b buyer's next RD lock still goes through", relock(T.cash, inv2, CASH));
    await expectBalances("F1b only the 4 locks are held back", shift(s0, [[seller, -2n * BOND, 0n], [inv2, 0n, -2n * CASH]]));
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
    // The Atom is now the lock delegate for both legs and has no way to release them.
    await expectFailure("F2 seller cannot reclaim DFABI delegated to the cancelled Atom", () => reclaim(T.bond, seller, bond.utxo, BOND));
    await expectFailure("F2 buyer cannot reclaim RD delegated to the cancelled Atom", () => reclaim(T.cash, inv2, cash.utxo, CASH));
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
