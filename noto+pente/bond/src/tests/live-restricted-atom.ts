import { TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { parseArgs } from "util";
import { getCachePath } from "paladin-example-common";
import atomJson from "../abis/RestrictedAtom.json";
import { Atom } from "../helpers/atom";
import { executeOutright } from "../lib/outright";
import { loadPlatform, waitForBalance } from "../lib/platform";

// LIVE negative test for RestrictedAtom (run against a cluster, not part of `npm test`).
// Builds an outright trade whose two legs are both delegated to its atom, then stops
// (injectFailureAfter) and checks, on chain:
//   1. a non-party (investor3) cancel reverts, atom still Pending, both locks still spent by the atom
//   2. a party (investor1) execute reverts (only the executor, the custodian, may execute)
//   3. a party (investor1) cancel succeeds: atom Cancelled, 2 LegReleased events, both owners' balances
//      come back (Noto cancelLock -> BondTracker.handleDelegateUnlock cancel outcome, fix ab8df78)
// Pass `--atom <addr> --bond-amount <n> --cash-amount <n>` to resume on an atom a previous run left
// Pending (lock ids are read back from the atom's cancel operations).
// Prints one JSON summary (tx hashes included) on stdout's last line.
const GET_LOCK_ABI = [
  {
    type: "function", name: "getLock", stateMutability: "view",
    inputs: [{ name: "lockId", type: "bytes32" }],
    outputs: [{
      name: "info", type: "tuple",
      components: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" },
        { name: "spendCommitment", type: "bytes32" }, { name: "cancelCommitment", type: "bytes32" },
      ],
    }],
  },
];

async function main(): Promise<boolean> {
  const p = await loadPlatform(getCachePath());
  const seller = p.investors.get("investor1")!;
  const buyer = p.investors.get("investor2")!;
  const stranger = p.investors.get("investor3")!;
  const bal = async (t: typeof p.notoBond, who: typeof seller) =>
    BigInt((await t.using(who.client).balanceOf(who.verifier, { account: who.verifier.lookup })).totalBalance);
  const { values } = parseArgs({ options: { atom: { type: "string" }, "bond-amount": { type: "string" }, "cash-amount": { type: "string" }, cache: { type: "string" } } });
  const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();
  const callAtom = async (addr: string, fn: string): Promise<any> =>
    p.node1.ptx.call({ type: TransactionType.PUBLIC, abi: atomJson.abi, function: fn, to: addr, from: p.bondCustodian.lookup, data: {} });

  const pre = { sellerBond: await bal(p.notoBond, seller), buyerCash: await bal(p.notoCash, buyer) };
  let atomAddr: string;
  let bondLockId: string;
  let cashLockId: string;
  let bondDelta: bigint;
  let cashDelta: bigint;
  if (values.atom) {
    atomAddr = values.atom;
    const ops = (await callAtom(atomAddr, "getCancelOperations")).cancelOperations as { contractAddress: string; lockId: string }[];
    bondLockId = norm(ops.find((o) => norm(o.contractAddress) === p.notoBond.address.toLowerCase())!.lockId);
    cashLockId = norm(ops.find((o) => norm(o.contractAddress) === p.notoCash.address.toLowerCase())!.lockId);
    bondDelta = BigInt(values["bond-amount"]!);
    cashDelta = BigInt(values["cash-amount"]!);
  } else {
    const trade = await executeOutright(p, {
      seller: "investor1", buyer: "investor2", units: "5", price: "3",
      tradeId: `live-negative-${Date.now()}`, injectFailureAfter: "cash-delegate",
    });
    if (trade.status !== "FAILED" || !trade.atomAddress) throw new Error(`unexpected trade state ${trade.status}`);
    atomAddr = trade.atomAddress;
    bondLockId = trade.bondLockId!;
    cashLockId = trade.cashLockId!;
    bondDelta = 0n;
    cashDelta = 0n;
  }
  // balance the owners must have again once the cancel has settled
  const target = { sellerBond: pre.sellerBond + bondDelta, buyerCash: pre.buyerCash + cashDelta };
  const atomAs = (who: typeof seller) => new Atom(who.client, atomAddr);
  const status = async () => String((await callAtom(atomAddr, "status"))["0"]);
  const spenders = async () => {
    const out: Record<string, string> = {};
    for (const [leg, token, lockId] of [["bond", p.notoBond.address, bondLockId], ["cash", p.notoCash.address, cashLockId]]) {
      const r: any = await p.node1.ptx.call({ type: TransactionType.PUBLIC, abi: GET_LOCK_ABI, function: "getLock", to: token, from: p.bondCustodian.lookup, data: { lockId } });
      out[leg] = norm((r.info ?? r["0"]).spender);
    }
    return out;
  };
  // ptx_sendTransaction rejects a call that reverts on gas estimation; a mined failure is a receipt.
  const attempt = async (f: () => Promise<any>): Promise<{ reverted: boolean; hash?: string; message: string }> => {
    try {
      const r = await f();
      return { reverted: r?.success === false, hash: r?.transactionHash, message: String(r?.failureMessage ?? "") };
    } catch (e: any) {
      const m = String(e?.response?.data?.error?.message ?? e?.message ?? e);
      if (!/revert/i.test(m)) throw e;
      return { reverted: true, message: m };
    }
  };
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`); };

  check("setup: atom pending and both legs delegated to it", (await status()) === "0" && Object.values(await spenders()).every((s) => s === norm(atomAddr)), `atom ${atomAddr} status=${await status()}`);

  const strangerCancel = await attempt(() => atomAs(stranger).cancel(stranger.verifier));
  check("non-party (investor3) cancel reverts with NotAParty", strangerCancel.reverted && /NotAParty/.test(strangerCancel.message), strangerCancel.message || "NO REVERT");
  check("after non-party cancel: atom still Pending, locks still held by atom", (await status()) === "0" && Object.values(await spenders()).every((s) => s === norm(atomAddr)), `status=${await status()}`);

  const partyExecute = await attempt(() => atomAs(seller).execute(seller.verifier));
  check("party (investor1) execute reverts with NotExecutor", partyExecute.reverted && /NotExecutor/.test(partyExecute.message), partyExecute.message || "NO REVERT");

  const cancel = await atomAs(seller).cancel(seller.verifier);
  check("party (investor1) cancel succeeds", cancel?.success === true, `tx ${cancel?.transactionHash}`);
  check("after party cancel: atom Cancelled", (await status()) === "2", `status=${await status()}`);
  const events = cancel?.transactionHash ? await p.node1.bidx.decodeTransactionEvents(cancel.transactionHash, atomJson.abi, "") : [];
  const released = events.filter((e) => e.soliditySignature.startsWith("event LegReleased"));
  const failed = events.filter((e) => e.soliditySignature.startsWith("event LegReleaseFailed"));
  check("cancel released both legs (2 LegReleased, 0 LegReleaseFailed)", released.length === 2 && failed.length === 0, `released=${released.length} failed=${failed.length}`);

  const sellerBond = await waitForBalance("investor1 bond", () => p.notoBond.using(seller.client).balanceOf(seller.verifier, { account: seller.verifier.lookup }), target.sellerBond);
  const buyerCash = await waitForBalance("investor2 cash", () => p.notoCash.using(buyer.client).balanceOf(buyer.verifier, { account: buyer.verifier.lookup }), target.buyerCash);
  check("balances restored after cancel (seller bond, buyer cash)", sellerBond !== undefined && buyerCash !== undefined, `bond ${sellerBond?.totalBalance} cash ${buyerCash?.totalBalance}`);

  console.log(JSON.stringify({ atom: atomAddr, bondLockId, cashLockId, strangerCancel, partyExecute, cancelTx: cancel?.transactionHash, checks }));
  return checks.every((c) => c.pass);
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
