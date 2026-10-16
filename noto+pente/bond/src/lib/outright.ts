import {
  INotoDomainReceipt,
  ITransactionReceipt,
  NotoInstance,
} from "@lfdecentralizedtrust/paladin-sdk";
import { randomUUID } from "crypto";
import { LONG_POLL_TIMEOUT } from "paladin-example-common";
import {
  Participant,
  Platform,
  computeConsideration,
  loadTrades,
  parseUnits,
  requireSuccess,
  waitForBalance,
} from "./platform";

export interface OutrightParams {
  seller: string;
  buyer: string;
  units: string | number;
  price: string;
  tradeId?: string;
  // Test-only: throw right after this step completes, to exercise rollback.
  injectFailureAfter?: TradeStep;
}

export type TradeStep =
  | "bond-lock"
  | "bond-prepare-unlock"
  | "cash-lock"
  | "cash-prepare-unlock"
  | "atom-create"
  | "bond-delegate"
  | "cash-delegate"
  | "atom-execute"
  | "settle";

export type TradeStatus = "SETTLED" | "ROLLED_BACK" | "FAILED";

export interface TradeRecord {
  tradeId: string;
  notoBondAddress: string;
  notoCashAddress: string;
  seller: string;
  buyer: string;
  units: string;
  price: string;
  consideration: string;
  // SETTLED: both legs moved. ROLLED_BACK: failed, every lock released to its owner.
  // FAILED: failed and could not be rolled back; locks listed below need an operator.
  status: TradeStatus;
  failedStep?: string;
  error?: string;
  rollbackError?: string;
  bondLockId?: string;
  cashLockId?: string;
  atomAddress?: string;
  rollbackAtomAddress?: string;
  openLocks?: { leg: "bond" | "cash"; lockId: string; owner: string; cancelCall?: string; delegatedTo?: string }[];
  timestamp: string;
}

// Raised for any problem found before the first lock: nothing was submitted on-chain.
export class TradeRejected extends Error {}

interface Leg {
  name: "bond" | "cash";
  token: NotoInstance; // bound to the owner's node
  owner: Participant;
  amount: bigint;
  lockId?: string;
  cancelCall?: string; // set once prepareUnlock succeeded
  delegatedTo?: string; // set once delegateLock succeeded
}

const lockInfoOf = (receipt: ITransactionReceipt) =>
  (receipt.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo;

type Future = { waitForReceipt(waitMs?: number, full?: boolean): Promise<ITransactionReceipt | undefined> };
const run = async (step: string, tx: Future, full = false) =>
  requireSuccess(await tx.waitForReceipt(LONG_POLL_TIMEOUT, full), step);

// ponytail: in-process per-account serialization; a multi-instance backend needs a shared lock (DB row / Redis).
const accountQueues = new Map<string, Promise<unknown>>();
async function withAccounts<T>(accounts: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(accounts)].sort();
  const previous = keys.map((k) => accountQueues.get(k) ?? Promise.resolve());
  const current = Promise.allSettled(previous).then(fn);
  const settled = current.catch(() => undefined);
  keys.forEach((k) => accountQueues.set(k, settled));
  try {
    return await current;
  } finally {
    keys.forEach((k) => accountQueues.get(k) === settled && accountQueues.delete(k));
  }
}

export function executeOutright(
  p: Platform,
  params: OutrightParams,
  log: (msg: string) => void = console.log
): Promise<TradeRecord> {
  return withAccounts([params.seller, params.buyer], () => runOutright(p, params, log));
}

async function runOutright(p: Platform, params: OutrightParams, log: (msg: string) => void): Promise<TradeRecord> {
  // --- Validation and pre-trade checks: reject before anything touches the chain ---
  const seller = p.investors.get(params.seller);
  const buyer = p.investors.get(params.buyer);
  const known = [...p.investors.keys()].join(", ");
  if (!seller) throw new TradeRejected(`unknown seller "${params.seller}" (known: ${known})`);
  if (!buyer) throw new TradeRejected(`unknown buyer "${params.buyer}" (known: ${known})`);
  if (seller.name === buyer.name) throw new TradeRejected("seller and buyer must differ");

  let units: bigint;
  let consideration: bigint;
  try {
    units = parseUnits(params.units);
    consideration = computeConsideration(units, params.price);
  } catch (err) {
    throw new TradeRejected((err as Error).message);
  }

  const { notoBond, notoCash, bondCustodian } = p;
  const bond: Leg = { name: "bond", token: notoBond.using(seller.client), owner: seller, amount: units };
  const cash: Leg = { name: "cash", token: notoCash.using(buyer.client), owner: buyer, amount: consideration };
  const balance = async (token: NotoInstance, who: Participant) =>
    BigInt((await token.using(who.client).balanceOf(who.verifier, { account: who.verifier.lookup })).totalBalance);

  const before = {
    sellerBond: await balance(notoBond, seller),
    sellerCash: await balance(notoCash, seller),
    buyerBond: await balance(notoBond, buyer),
    buyerCash: await balance(notoCash, buyer),
  };
  if (before.sellerBond < units) {
    throw new TradeRejected(`${seller.name} holds ${before.sellerBond} bond, cannot sell ${units}`);
  }
  if (before.buyerCash < consideration) {
    throw new TradeRejected(`${buyer.name} holds ${before.buyerCash} cash, needs ${consideration}`);
  }
  const investorList = await p.bondTracker.investorList(bondCustodian);
  if (!(await investorList.isRegistered(bondCustodian, await buyer.verifier.address()))) {
    throw new TradeRejected(`${buyer.name} is not on the bond's investor whitelist`);
  }

  const tradeId = params.tradeId ?? randomUUID();
  if (loadTrades(p.dataDir, notoBond.address).some((t) => t.tradeId === tradeId)) {
    throw new TradeRejected(`trade ${tradeId} already recorded`);
  }
  const trade: TradeRecord = {
    tradeId,
    notoBondAddress: notoBond.address,
    notoCashAddress: notoCash.address,
    seller: seller.name,
    buyer: buyer.name,
    units: units.toString(),
    price: params.price,
    consideration: consideration.toString(),
    status: "FAILED",
    timestamp: new Date().toISOString(),
  };
  // Paladin idempotency keys are node-global; scope them to this bond series like the tradeId check above.
  const key = (step: string) => `${notoBond.address}-${tradeId}-${step}`;
  let step: TradeStep = "bond-lock";
  const done = (s: TradeStep) => {
    if (params.injectFailureAfter === s) throw new Error(`injected failure after ${s}`);
  };

  const lock = async (leg: Leg, s: TradeStep) => {
    step = s;
    log(`[${s}] ${leg.owner.name} locks ${leg.amount} ${leg.name}`);
    const r = await run(s, leg.token.lock(leg.owner.verifier, { amount: leg.amount.toString(), data: "0x" }, key(s)), true);
    leg.lockId = lockInfoOf(r)?.lockId;
    if (!leg.lockId) throw new Error("no lockId in receipt");
    done(s);
  };
  const prepare = async (leg: Leg, to: Participant, s: TradeStep) => {
    step = s;
    log(`[${s}] ${leg.name} -> ${to.name}`);
    const r = await run(s, leg.token.prepareUnlock(leg.owner.verifier, {
      lockId: leg.lockId!,
      from: leg.owner.verifier,
      recipients: [{ to: to.verifier, amount: leg.amount.toString() }],
      unlockData: "0x",
      data: "0x",
    }, key(s)), true);
    const info = lockInfoOf(r);
    if (!info?.unlockCall || !info.cancelCall) throw new Error("no unlockCall/cancelCall in receipt");
    leg.cancelCall = info.cancelCall;
    done(s);
    return info.unlockCall;
  };
  const delegate = async (leg: Leg, to: string, s: string) => {
    log(`[${s}] ${leg.owner.name} delegates ${leg.name} lock to ${to}`);
    await run(s, leg.token.delegateLock(leg.owner.verifier, { lockId: leg.lockId!, delegate: to, data: "0x" }, key(s)));
    leg.delegatedTo = to;
  };

  try {
    // Bond leg first: seller locks, prepares release to buyer (BondTracker enforces whitelist)
    await lock(bond, "bond-lock");
    const bondUnlockCall = await prepare(bond, buyer, "bond-prepare-unlock");
    // Cash leg: buyer locks, prepares payment to seller
    await lock(cash, "cash-lock");
    const cashUnlockCall = await prepare(cash, seller, "cash-prepare-unlock");

    // Settlement: custodian (node1) acts as settlement agent
    step = "atom-create";
    log(`[${step}] custodian builds atom (bond leg + cash leg)`);
    // RestrictedAtom: only the two trade parties and BI (executor) may cancel/execute it, and a
    // cancel releases whichever legs were already delegated (cancelOperations).
    const atom = await p.atomFactory.create(
      bondCustodian,
      [
        { contractAddress: notoBond.address, callData: bondUnlockCall },
        { contractAddress: notoCash.address, callData: cashUnlockCall },
      ],
      [bond, cash].map((l) => ({ contractAddress: l.token.address, lockId: l.lockId!, callData: l.cancelCall! })),
      [await seller.verifier.address(), await buyer.verifier.address()],
      await bondCustodian.address()
    );
    if (!atom) throw new Error("AtomDeployed event not found");
    trade.atomAddress = atom.address;
    done(step);

    step = "bond-delegate";
    await delegate(bond, atom.address, step);
    done(step);
    step = "cash-delegate";
    await delegate(cash, atom.address, step);
    done(step);

    // Execute immediately to keep the delegated window short (cancel is restricted to the parties/BI).
    step = "atom-execute";
    log(`[${step}] custodian executes atom`);
    requireSuccess(await atom.execute(bondCustodian), step);
    done(step);

    step = "settle";
    log(`[${step}] waiting for balances`);
    const settled = await Promise.all([
      waitForBalance(`${seller.name} bond`, () => bond.token.balanceOf(seller.verifier, { account: seller.verifier.lookup }), before.sellerBond - units),
      waitForBalance(`${seller.name} cash`, () => notoCash.using(seller.client).balanceOf(seller.verifier, { account: seller.verifier.lookup }), before.sellerCash + consideration),
      waitForBalance(`${buyer.name} bond`, () => notoBond.using(buyer.client).balanceOf(buyer.verifier, { account: buyer.verifier.lookup }), before.buyerBond + units),
      waitForBalance(`${buyer.name} cash`, () => cash.token.balanceOf(buyer.verifier, { account: buyer.verifier.lookup }), before.buyerCash - consideration),
    ]);
    if (settled.some((b) => b === undefined)) throw new Error("balances did not settle to expected values");
  } catch (err) {
    trade.failedStep = step;
    trade.error = (err as Error).message;
    trade.bondLockId = bond.lockId;
    trade.cashLockId = cash.lockId;
    log(`[${step}] FAILED: ${trade.error}`);
    if (step === "atom-execute" || step === "settle") {
      // The atom may have executed; never "roll back" funds that might already have moved.
      trade.error += " (atom may have executed; check balances before any manual action)";
    } else {
      try {
        trade.rollbackAtomAddress = await rollback(p, [bond, cash], key, log);
        const restored = await Promise.all([
          waitForBalance(`${seller.name} bond`, () => bond.token.balanceOf(seller.verifier, { account: seller.verifier.lookup }), before.sellerBond),
          waitForBalance(`${buyer.name} cash`, () => cash.token.balanceOf(buyer.verifier, { account: buyer.verifier.lookup }), before.buyerCash),
        ]);
        if (restored.some((b) => b === undefined)) throw new Error("balances did not return to pre-trade values");
        trade.status = "ROLLED_BACK";
      } catch (rbErr) {
        trade.rollbackError = (rbErr as Error).message;
        log(`[rollback] FAILED: ${trade.rollbackError}`);
      }
    }
    if (trade.status === "FAILED") {
      trade.openLocks = [bond, cash]
        .filter((l) => l.lockId)
        .map((l) => ({ leg: l.name, lockId: l.lockId!, owner: l.owner.name, cancelCall: l.cancelCall, delegatedTo: l.delegatedTo }));
    }
    trade.timestamp = new Date().toISOString();
    return trade;
  }

  trade.status = "SETTLED";
  trade.bondLockId = bond.lockId;
  trade.cashLockId = cash.lockId;
  trade.timestamp = new Date().toISOString();
  return trade;
}

// Releases every lock this trade created back to its owner. Returns the cancel atom address.
// The lock's spender is the hooks privacy group, so nobody can call cancelLock directly, and a private
// `unlock` reverts on this Paladin version (NotoInvalidUnlockInputs: the lock-info state is counted as an
// input). So: any unprepared lock is first prepared with its owner as recipient; then the custodian builds
// an atom of the locks' cancelCalls, owners delegate to it, and executing it emits LockCancelled, which
// the notary node turns into handleDelegateUnlock on the tracker. A lock already delegated to the trade
// atom can only be spent by that atom, so rollback is refused.
async function rollback(
  p: Platform,
  legs: Leg[],
  key: (step: string) => string,
  log: (msg: string) => void
): Promise<string | undefined> {
  const locked = legs.filter((l) => l.lockId);
  const delegated = locked.filter((l) => l.delegatedTo);
  if (delegated.length > 0) {
    throw new Error(`${delegated.map((l) => l.name).join("+")} lock already delegated to trade atom ${delegated[0].delegatedTo}; complete or escalate manually`);
  }
  if (locked.length === 0) return undefined;

  for (const leg of locked.filter((l) => !l.cancelCall)) {
    const s = `rollback-prepare-${leg.name}`;
    log(`[${s}] ${leg.owner.name} prepares ${leg.amount} ${leg.name} back to self`);
    const r = await run(s, leg.token.prepareUnlock(leg.owner.verifier, {
      lockId: leg.lockId!,
      from: leg.owner.verifier,
      recipients: [{ to: leg.owner.verifier, amount: leg.amount.toString() }],
      unlockData: "0x",
      data: "0x",
    }, key(s)), true);
    leg.cancelCall = lockInfoOf(r)?.cancelCall;
    if (!leg.cancelCall) throw new Error(`${s}: no cancelCall in receipt`);
  }

  const prepared = locked;
  log(`[rollback-atom-create] custodian builds cancel atom (${prepared.map((l) => l.name).join(" + ")})`);
  const atom = await p.atomFactory.create(
    p.bondCustodian,
    prepared.map((l) => ({ contractAddress: l.token.address, callData: l.cancelCall! })),
    [],
    await Promise.all(prepared.map((l) => l.owner.verifier.address())),
    await p.bondCustodian.address()
  );
  if (!atom) throw new Error("rollback AtomDeployed event not found");
  for (const leg of prepared) {
    const s = `rollback-delegate-${leg.name}`;
    log(`[${s}] ${leg.owner.name} delegates ${leg.name} lock to cancel atom`);
    await run(s, leg.token.delegateLock(leg.owner.verifier, { lockId: leg.lockId!, delegate: atom.address, data: "0x" }, key(s)));
  }
  log("[rollback-atom-execute] custodian executes cancel atom");
  requireSuccess(await atom.execute(p.bondCustodian), "rollback-atom-execute");
  return atom.address;
}

// Operator recovery for a FAILED trade whose locks were never delegated: releases them to their owners.
export async function recoverTrade(
  p: Platform,
  trade: TradeRecord,
  log: (msg: string) => void = console.log
): Promise<TradeRecord> {
  if (trade.status !== "FAILED") throw new TradeRejected(`trade ${trade.tradeId} is ${trade.status}, nothing to recover`);
  const legs: Leg[] = (trade.openLocks ?? []).map((l) => {
    const owner = p.investors.get(l.owner);
    if (!owner) throw new TradeRejected(`unknown lock owner ${l.owner}`);
    const token = (l.leg === "bond" ? p.notoBond : p.notoCash).using(owner.client);
    const amount = BigInt(l.leg === "bond" ? trade.units : trade.consideration);
    return { name: l.leg, token, owner, amount, lockId: l.lockId, cancelCall: l.cancelCall, delegatedTo: l.delegatedTo };
  });
  if (legs.length === 0) throw new TradeRejected(`trade ${trade.tradeId} has no open locks`);
  const balance = (leg: Leg) =>
    leg.token.balanceOf(leg.owner.verifier, { account: leg.owner.verifier.lookup }).then((b) => BigInt(b.totalBalance));
  const before = await Promise.all(legs.map(balance));

  const recovered: TradeRecord = { ...trade, timestamp: new Date().toISOString() };
  try {
    recovered.rollbackAtomAddress = await rollback(p, legs, (s) => `${p.notoBond.address}-${trade.tradeId}-recover-${s}`, log);
    const restored = await Promise.all(
      legs.map((leg, i) =>
        waitForBalance(`${leg.owner.name} ${leg.name}`, () => leg.token.balanceOf(leg.owner.verifier, { account: leg.owner.verifier.lookup }), before[i] + leg.amount)
      )
    );
    if (restored.some((b) => b === undefined)) throw new Error("balances did not return to pre-trade values");
    recovered.status = "ROLLED_BACK";
    delete recovered.openLocks;
    delete recovered.rollbackError;
  } catch (err) {
    recovered.rollbackError = (err as Error).message;
  }
  return recovered;
}
