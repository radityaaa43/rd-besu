import PaladinClient, { INotoDomainReceipt, PenteFactory, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, getCachePath, LONG_POLL_TIMEOUT, POLL_INTERVAL } from "paladin-example-common";
import { parseArgs } from "util";
import atomJson from "../abis/RestrictedAtom.json";
import atomFactoryJson from "../abis/RestrictedAtomFactory.json";
import publicJson from "../abis/BondTrackerPublic.json";
import { Atom } from "../helpers/atom";
import { newBondSubscription } from "../helpers/bondsubscription";
import { loadPlatform, requireSuccess, waitForBalance } from "../lib/platform";

// LIVE cancel test for a PENDING primary-sale (issuance) atom (run against a cluster, not part of `npm test`).
// Works on an already issued series that still has unsold units (the round stays open). For each case it:
//   1. runs the issuance flow up to and including the delegateLock calls, but NOT execute
//      (lock cash, lock bond, prepareUnlock x2, RestrictedBondSubscription.preparePayment/prepareBond/distribute, delegate x2)
//   2. checks a non-party cancel reverts NotAParty and the atom stays Pending with both locks still held by it
//   3. cancels as a party (case A: the investor, case B: the custodian) and checks both legs are released:
//      investor cash back, custodian bond back, unsold units unchanged, BondTracker locked balance 0,
//      public tracker status not moved to COMPLETE.
// Last stdout line is one JSON summary with the tx hashes.
const GET_LOCK_ABI = [{
  type: "function", name: "getLock", stateMutability: "view",
  inputs: [{ name: "lockId", type: "bytes32" }],
  outputs: [{ name: "info", type: "tuple", components: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "spendCommitment", type: "bytes32" }, { name: "cancelCommitment", type: "bytes32" },
  ] }],
}];
const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();

async function main(): Promise<boolean> {
  const { values } = parseArgs({ options: { units: { type: "string", default: "10" }, cache: { type: "string" } } });
  const UNITS = Number(values.units);
  const p = await loadPlatform(getCachePath());
  const penteFactory = new PenteFactory(p.node1, "pente");
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`); };
  const pub = (to: string, abi: any, fn: string, data: any = {}) =>
    p.node1.ptx.call({ type: TransactionType.PUBLIC, abi, function: fn, to, from: p.bondCustodian.lookup, data }) as Promise<any>;
  const priv = async (fn: string, data: any = {}) => String((await p.bondTracker.call({ from: p.bondCustodian.lookup, function: fn, data }))[0]);
  const custodianAddr = await p.bondCustodian.address();
  const price = Number(await priv("discountPrice"));
  const cash = UNITS * price;
  const bal = async (t: typeof p.notoBond, c: PaladinClient, v: typeof p.bondCustodian) => BigInt((await t.using(c).balanceOf(v, { account: v.lookup })).totalBalance);
  const attempt = async (f: () => Promise<any>): Promise<{ reverted: boolean; message: string }> => {
    try {
      const r = await f();
      return { reverted: r?.success === false, message: String(r?.failureMessage ?? "") };
    } catch (e: any) {
      const m = String(e?.response?.data?.error?.message ?? e?.message ?? e);
      if (!/revert/i.test(m)) throw e;
      return { reverted: true, message: m };
    }
  };
  // The private tracker is updated by Noto's hook after the base-ledger tx, so its view lags the Noto state by a few seconds.
  const waitPriv = async (fn: string, data: any, expected: string) => {
    const start = Date.now();
    let v = await priv(fn, data);
    while (v !== expected && Date.now() - start < LONG_POLL_TIMEOUT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      v = await priv(fn, data);
    }
    return v;
  };
  const publicStatus = async () => String((await pub(p.data.bondTrackerPublicAddress, publicJson.abi, "status"))["0"]);

  // one issuance purchase, stopped before execute. Returns the atom and its lock ids.
  const preparePending = async (invName: string) => {
    const inv = p.investors.get(invName)!;
    const rec = p.data.investors.find((r) => r.name === invName)!;
    const group = await penteFactory.using(inv.client).resumePrivacyGroup({ id: rec.investorCustodianGroupId });
    if (!group) throw new Error(`cannot resume ${invName} group`);
    const sub = await newBondSubscription(group, inv.verifier, {
      bondAddress_: p.notoBond.address, units_: UNITS, custodian_: custodianAddr, atomFactory_: p.data.restrictedAtomFactoryAddress,
    });
    if (!sub) throw new Error("subscription deploy failed");
    const hashes: Record<string, string> = {};
    const note = (k: string, r: any) => { hashes[k] = r.transactionHash; return r; };
    const dr = (r: any) => r.domainReceipt as INotoDomainReceipt;

    const lockCash = requireSuccess(await p.notoCash.using(inv.client).lock(inv.verifier, { amount: cash, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "lock cash");
    const cashLockId = dr(lockCash).lockInfo!.lockId!;
    const prepCash = requireSuccess(await p.notoCash.using(inv.client).prepareUnlock(inv.verifier, {
      lockId: cashLockId, from: inv.verifier, recipients: [{ to: p.bondCustodian, amount: cash }], unlockData: "0x", data: "0x",
    }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "prepare cash unlock");
    const lockBond = requireSuccess(await p.notoBond.lock(p.bondCustodian, { amount: UNITS, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "lock bond");
    const bondLockId = dr(lockBond).lockInfo!.lockId!;
    const prepBond = requireSuccess(await p.notoBond.prepareUnlock(p.bondCustodian, {
      lockId: bondLockId, from: p.bondCustodian, recipients: [{ to: inv.verifier, amount: UNITS }], unlockData: "0x", data: "0x",
    }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "prepare bond unlock");
    note("lockCash", lockCash); note("lockBond", lockBond);

    requireSuccess(await sub.using(inv.client).preparePayment(inv.verifier, {
      to: p.notoCash.address, encodedCall: dr(prepCash).lockInfo!.unlockCall!, lockId: cashLockId, cancelCall: dr(prepCash).lockInfo!.cancelCall!,
    }).waitForReceipt(DEFAULT_POLL_TIMEOUT), "preparePayment");
    requireSuccess(await sub.using(p.node1).prepareBond(p.bondCustodian, {
      to: p.notoBond.address, encodedCall: dr(prepBond).lockInfo!.unlockCall!, lockId: bondLockId, cancelCall: dr(prepBond).lockInfo!.cancelCall!,
    }).waitForReceipt(DEFAULT_POLL_TIMEOUT), "prepareBond");
    const dist = requireSuccess(await sub.using(p.node1).distribute(p.bondCustodian).waitForReceipt(DEFAULT_POLL_TIMEOUT), "distribute");
    note("distribute", dist);
    const evs = await p.node1.bidx.decodeTransactionEvents(dist.transactionHash, atomFactoryJson.abi, "");
    const atomAddr = evs.find((e) => e.soliditySignature === "event AtomDeployed(address addr)")?.data.addr as string;
    if (!atomAddr) throw new Error("no AtomDeployed event");
    note("delegateCash", requireSuccess(await p.notoCash.using(inv.client).delegateLock(inv.verifier, { lockId: cashLockId, delegate: atomAddr, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT), "delegate cash"));
    note("delegateBond", requireSuccess(await p.notoBond.delegateLock(p.bondCustodian, { lockId: bondLockId, delegate: atomAddr, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT), "delegate bond"));
    return { atomAddr, cashLockId, bondLockId, hashes };
  };

  const runCase = async (label: string, invName: string, strangerName: string, cancelBy: "investor" | "custodian") => {
    const inv = p.investors.get(invName)!;
    const stranger = p.investors.get(strangerName)!;
    await waitPriv("lockedBalanceOf", { account: custodianAddr }, "0"); // previous case's release must have reached the tracker
    const pre = {
      invCash: await bal(p.notoCash, inv.client, inv.verifier), custBond: await bal(p.notoBond, p.node1, p.bondCustodian),
      unsold: await priv("availableUnitsPrivate"), locked: await priv("lockedBalanceOf", { account: custodianAddr }), pubStatus: await publicStatus(),
    };
    console.log(`\n=== ${label}: ${invName} buys ${UNITS} units for ${cash}, cancelled by ${cancelBy}; pre=${JSON.stringify(pre, (_, v) => typeof v === "bigint" ? String(v) : v)}`);
    const { atomAddr, cashLockId, bondLockId, hashes } = await preparePending(invName);
    const atom = (c: PaladinClient) => new Atom(c, atomAddr);
    const status = async () => String((await pub(atomAddr, atomJson.abi, "status"))["0"]);
    const spenders = async () => {
      const out: string[] = [];
      for (const [token, lockId] of [[p.notoBond.address, bondLockId], [p.notoCash.address, cashLockId]]) {
        const r: any = await pub(token, GET_LOCK_ABI, "getLock", { lockId });
        out.push(norm((r.info ?? r["0"]).spender));
      }
      return out;
    };
    const held = async () => (await spenders()).every((s) => s === norm(atomAddr));
    const parties = ((await pub(atomAddr, atomJson.abi, "getParties")).parties as string[]).map(norm);
    const executor = norm((await pub(atomAddr, atomJson.abi, "executor"))["0"]);
    check(`${label}: pending issuance atom ${atomAddr}: parties=[investor,custodian], executor=custodian, Pending, both legs delegated`,
      (await status()) === "0" && (await held()) && parties.length === 2 && parties[0] === norm(await inv.verifier.address()) && parties[1] === norm(custodianAddr) && executor === norm(custodianAddr),
      `status=${await status()} parties=${parties} executor=${executor}`);
    const during = { invCash: await bal(p.notoCash, inv.client, inv.verifier), custBond: await bal(p.notoBond, p.node1, p.bondCustodian), locked: await priv("lockedBalanceOf", { account: custodianAddr }), unsold: await priv("availableUnitsPrivate") };
    console.log(`${label}: while pending: ${JSON.stringify(during, (_, v) => typeof v === "bigint" ? String(v) : v)}`);

    const stranger1 = await attempt(() => atom(stranger.client).cancel(stranger.verifier));
    check(`${label}: non-party (${strangerName}) cancel reverts with NotAParty`, stranger1.reverted && /NotAParty/.test(stranger1.message), stranger1.message || "NO REVERT");
    check(`${label}: after non-party cancel: atom still Pending, both locks still held by the atom`, (await status()) === "0" && (await held()), `status=${await status()}`);

    const by = cancelBy === "investor" ? { c: inv.client, v: inv.verifier } : { c: p.node1, v: p.bondCustodian };
    const cancel = await atom(by.c).cancel(by.v);
    check(`${label}: ${cancelBy} cancel succeeds`, cancel?.success === true, `tx ${cancel?.transactionHash}`);
    check(`${label}: atom Cancelled`, (await status()) === "2", `status=${await status()}`);
    const evs = cancel?.transactionHash ? await p.node1.bidx.decodeTransactionEvents(cancel.transactionHash, atomJson.abi, "") : [];
    const released = evs.filter((e) => e.soliditySignature.startsWith("event LegReleased")).length;
    const failed = evs.filter((e) => e.soliditySignature.startsWith("event LegReleaseFailed")).length;
    check(`${label}: cancel released both legs (2 LegReleased, 0 LegReleaseFailed)`, released === 2 && failed === 0, `released=${released} failed=${failed}`);

    const cashBack = await waitForBalance(`${invName} cash`, () => p.notoCash.using(inv.client).balanceOf(inv.verifier, { account: inv.verifier.lookup }), pre.invCash);
    const bondBack = await waitForBalance("custodian bond", () => p.notoBond.balanceOf(p.bondCustodian, { account: p.bondCustodian.lookup }), pre.custBond);
    check(`${label}: investor cash back, custodian bond back`, cashBack !== undefined && bondBack !== undefined, `${invName} cash ${cashBack?.totalBalance} (pre ${pre.invCash}), custodian bond ${bondBack?.totalBalance} (pre ${pre.custBond})`);
    const after = { unsold: await priv("availableUnitsPrivate"), locked: await waitPriv("lockedBalanceOf", { account: custodianAddr }, "0"), pubStatus: await publicStatus() };
    check(`${label}: unsold units unchanged, BondTracker locked balance 0, public tracker status unchanged and not COMPLETE`,
      after.unsold === pre.unsold && after.locked === "0" && after.pubStatus === pre.pubStatus && after.pubStatus !== "3",
      `unsold ${pre.unsold}->${after.unsold} locked ${during.locked}->${after.locked} publicStatus ${pre.pubStatus}->${after.pubStatus}`);
    return { label, atom: atomAddr, cashLockId, bondLockId, hashes, strangerCancel: stranger1.message, cancelTx: cancel?.transactionHash, pre: { ...pre, invCash: String(pre.invCash), custBond: String(pre.custBond) }, during: { ...during, invCash: String(during.invCash), custBond: String(during.custBond) }, after };
  };

  const a = await runCase("A", "investor1", "investor2", "investor");
  const b = await runCase("B", "investor3", "investor1", "custodian");
  console.log(JSON.stringify({ series: p.data.notoBondAddress, cases: [a, b], checks }));
  return checks.every((c) => c.pass);
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
