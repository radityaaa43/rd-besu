import PaladinClient, { INotoDomainReceipt, NotoInstance, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import * as fs from "fs";
import {
  DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, POLL_INTERVAL,
  findLatestContractDataFile, getCachePath, nodeConnections,
} from "paladin-example-common";
import atomJson from "../abis/RestrictedAtom.json";
import { AtomFactory } from "../helpers/atom";
import type { ContractData } from "./data-persistence";

// LIVE cancel test for a PENDING swap atom (run against a cluster, not part of any build).
// Reuses the tokens and atom factory a previous `npm run start` deployed (latest contract-data file in --cache).
// For each case: lock asset (investor1) and cash (investor2), prepareUnlock both, create a RestrictedAtom
// (parties = both investors, executor = investor2), delegate both locks to it, and STOP before execute. Then:
//   - a non-party (the cash issuer, "the bank") cancel reverts NotAParty; a party that is not the executor
//     (investor1) execute reverts NotExecutor; atom stays Pending and both locks stay held by it
//   - a party cancels (case A: investor1, case B: investor2): atom Cancelled, 2 LegReleased,
//     both balances return to their pre-swap values
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
const AMOUNT = 5;

async function main(): Promise<boolean> {
  const file = findLatestContractDataFile(getCachePath());
  if (!file) throw new Error("no contract data in --cache; run `npm run start` first");
  const data: ContractData = JSON.parse(fs.readFileSync(file, "utf8"));
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const node1 = clients[0], node3 = clients[2], node4 = clients[3];
  const [cashIssuer] = node1.getVerifiers(data.participants.cashIssuer);
  const [inv1] = node3.getVerifiers(data.participants.investor1);
  const [inv2] = node4.getVerifiers(data.participants.investor2);
  const asset = new NotoInstance(node1, data.notoAssetAddress);
  const cash = new NotoInstance(node1, data.notoCashAddress);
  const factory = new AtomFactory(node1, data.atomFactoryAddress);
  const inv1Addr = await inv1.address(), inv2Addr = await inv2.address();

  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`); };
  const pub = (to: string, abi: any, fn: string, d: any = {}) => node1.ptx.call({ type: TransactionType.PUBLIC, abi, function: fn, to, from: cashIssuer.lookup, data: d }) as Promise<any>;
  const bal = async (t: NotoInstance, c: PaladinClient, v: typeof inv1) => BigInt((await t.using(c).balanceOf(v, { account: v.lookup })).totalBalance);
  const waitBal = async (t: NotoInstance, c: PaladinClient, v: typeof inv1, expected: bigint) => {
    const start = Date.now();
    while (Date.now() - start < LONG_POLL_TIMEOUT) {
      if ((await bal(t, c, v)) === expected) return true;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
    return false;
  };
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
  const ok = (r: any, step: string) => { if (!r || r.success === false) throw new Error(`${step}: ${r?.failureMessage ?? "no receipt"}`); return r; };
  const dr = (r: any) => (r.domainReceipt as INotoDomainReceipt).lockInfo!;

  const runCase = async (label: string, cancelBy: "investor1" | "investor2") => {
    const pre = { asset1: await bal(asset, node3, inv1), cash2: await bal(cash, node4, inv2) };
    console.log(`\n=== ${label}: swap ${AMOUNT} asset (investor1) for ${AMOUNT} cash (investor2), cancelled by ${cancelBy}; pre asset1=${pre.asset1} cash2=${pre.cash2}`);
    const lockA = ok(await asset.using(node3).lock(inv1, { amount: AMOUNT, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "lock asset");
    const prepA = ok(await asset.using(node3).prepareUnlock(inv1, { lockId: dr(lockA).lockId!, from: inv1, recipients: [{ to: inv2, amount: AMOUNT }], unlockData: "0x", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "prepare asset unlock");
    const lockC = ok(await cash.using(node4).lock(inv2, { amount: AMOUNT, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "lock cash");
    const prepC = ok(await cash.using(node4).prepareUnlock(inv2, { lockId: dr(lockC).lockId!, from: inv2, recipients: [{ to: inv1, amount: AMOUNT }], unlockData: "0x", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true), "prepare cash unlock");
    const assetLockId = dr(lockA).lockId!, cashLockId = dr(lockC).lockId!;
    const atom = await factory.create(cashIssuer,
      [{ contractAddress: asset.address, callData: dr(prepA).unlockCall! }, { contractAddress: cash.address, callData: dr(prepC).unlockCall! }],
      [{ contractAddress: asset.address, lockId: assetLockId, callData: dr(prepA).cancelCall! }, { contractAddress: cash.address, lockId: cashLockId, callData: dr(prepC).cancelCall! }],
      [inv1Addr, inv2Addr], inv2Addr);
    if (!atom) throw new Error("atom create failed");
    const dA = ok(await asset.using(node3).delegateLock(inv1, { lockId: assetLockId, delegate: atom.address, data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT), "delegate asset");
    const dC = ok(await cash.using(node4).delegateLock(inv2, { lockId: cashLockId, delegate: atom.address, data: "0x" }).waitForReceipt(LONG_POLL_TIMEOUT), "delegate cash");

    const status = async () => String((await pub(atom.address, atomJson.abi, "status"))["0"]);
    const held = async () => {
      for (const [token, lockId] of [[asset.address, assetLockId], [cash.address, cashLockId]]) {
        const r: any = await pub(token, GET_LOCK_ABI, "getLock", { lockId });
        if (norm((r.info ?? r["0"]).spender) !== norm(atom.address)) return false;
      }
      return true;
    };
    const parties = ((await pub(atom.address, atomJson.abi, "getParties")).parties as string[]).map(norm).sort();
    const executor = norm((await pub(atom.address, atomJson.abi, "executor"))["0"]);
    check(`${label}: pending swap atom ${atom.address}: parties=[investor1,investor2], executor=investor2, Pending, both legs delegated`,
      (await status()) === "0" && (await held()) && parties.join() === [norm(inv1Addr), norm(inv2Addr)].sort().join() && executor === norm(inv2Addr), `status=${await status()} parties=${parties} executor=${executor}`);
    const during = { asset1: await bal(asset, node3, inv1), cash2: await bal(cash, node4, inv2) };
    console.log(`${label}: while pending: asset1=${during.asset1} cash2=${during.cash2}`);

    const bank = await attempt(() => atom.using(node1).cancel(cashIssuer));
    check(`${label}: non-party (cash issuer) cancel reverts with NotAParty`, bank.reverted && /NotAParty/.test(bank.message), bank.message || "NO REVERT");
    const exec1 = await attempt(() => atom.using(node3).execute(inv1));
    check(`${label}: party that is not the executor (investor1) execute reverts with NotExecutor`, exec1.reverted && /NotExecutor/.test(exec1.message), exec1.message || "NO REVERT");
    check(`${label}: after the rejections: atom still Pending, both locks still held by the atom`, (await status()) === "0" && (await held()), `status=${await status()}`);

    const by = cancelBy === "investor1" ? { c: node3, v: inv1 } : { c: node4, v: inv2 };
    const cancel = await atom.using(by.c).cancel(by.v);
    check(`${label}: ${cancelBy} cancel succeeds`, cancel?.success === true, `tx ${cancel?.transactionHash}`);
    check(`${label}: atom Cancelled`, (await status()) === "2", `status=${await status()}`);
    const evs = cancel?.transactionHash ? await node1.bidx.decodeTransactionEvents(cancel.transactionHash, atomJson.abi, "") : [];
    const released = evs.filter((e) => e.soliditySignature.startsWith("event LegReleased")).length;
    const failed = evs.filter((e) => e.soliditySignature.startsWith("event LegReleaseFailed")).length;
    check(`${label}: cancel released both legs (2 LegReleased, 0 LegReleaseFailed)`, released === 2 && failed === 0, `released=${released} failed=${failed}`);
    const a1 = await waitBal(asset, node3, inv1, pre.asset1), c2 = await waitBal(cash, node4, inv2, pre.cash2);
    check(`${label}: balances back to pre-swap values (investor1 asset, investor2 cash)`, a1 && c2, `asset1 ${await bal(asset, node3, inv1)} (pre ${pre.asset1}), cash2 ${await bal(cash, node4, inv2)} (pre ${pre.cash2})`);
    return { label, atom: atom.address, assetLockId, cashLockId, delegateAssetTx: dA.transactionHash, delegateCashTx: dC.transactionHash, bankCancel: bank.message, nonExecutorExecute: exec1.message, cancelTx: cancel?.transactionHash, pre: { asset1: String(pre.asset1), cash2: String(pre.cash2) }, during: { asset1: String(during.asset1), cash2: String(during.cash2) } };
  };

  const a = await runCase("A", "investor1");
  const b = await runCase("B", "investor2");
  console.log(JSON.stringify({ assetToken: asset.address, cashToken: cash.address, atomFactory: factory.address, cases: [a, b], checks }));
  return checks.every((c) => c.pass);
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
