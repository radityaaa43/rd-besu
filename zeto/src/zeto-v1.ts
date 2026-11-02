// Zeto V1 lock lifecycle (Paladin main + PR #1189, zeto-contracts v0.5.1), shared by the scripts and
// src/flows.ts. It replaces V0's lock / prepareTransferLocked / delegateLock(address) / transferLocked:
//   createLock (recipients are PINNED here)  ->  prepareSpendLock  ->  delegateLockV1(spender = Atom)
//   -> Atom.execute calls spendLock(lockId, spendArgs, data)      cancelLock = the reclaim path
// Copied from examples/swap/src/index.ts (PR #1189 merge 82fbd49ce) lines 177-300; cancelLock is the
// domain method IZetoFungible_V1.cancelLock (the SDK has no wrapper for it, so its ABI is inline here).
import PaladinClient, { ITransactionReceipt, PaladinVerifier, TransactionType, ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { LONG_POLL_TIMEOUT } from "./common";

// Deploy params of the V1 axis (examples/swap/src/index.ts:136-143). On the live cluster the V1 implementation is registered in the factory as "Zeto_Anon_V1"; "Zeto_Anon" is still the v0.2.2 one. The ONLY place that name is set. Without all three the pool is on the V0 axis
// and reverts on the first proving call against zeto-contracts v0.5.x.
export const ZETO_V1 = { tokenName: "Zeto_Anon_V1", domainConfigSchema: "v1", zetoVariant: 1, factoryVersion: 1 } as const;

export type LockParty = { lookup: string; c: PaladinClient; v: PaladinVerifier };
export type Lock = { lockId: string; receipt: ITransactionReceipt; states: any[] };
export type SpendLeg = { lockId: string; call: string; spendArgs: string; encode: (spendArgs: string) => string; states: any[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const must = <V>(v: V | undefined | null, what: string): V => {
  if (v === undefined || v === null) throw new Error(`${what} missing`);
  return v;
};

// Receipt with a REAL deadline (the SDK's waitForReceipt loops `ms` iterations of ~100 ms, so 120000 is hours).
export async function receiptWithin(c: PaladinClient, id: string | Promise<string>, ms = LONG_POLL_TIMEOUT): Promise<ITransactionReceipt | undefined> {
  const txId = await id;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const r = await c.ptx.getTransactionReceipt(txId);
    if (r != null) return r;
  }
  return undefined;
}

// `owner` locks `amount` for `to` (the spend recipient, fixed now), then the lock id is read from the
// state receipt (the lock-info state carries it). Locked coins are excluded from balanceOf.
export async function createLock(zeto: ZetoInstance, owner: LockParty, to: LockParty, amount: bigint, ms = LONG_POLL_TIMEOUT): Promise<Lock> {
  const receipt = await receiptWithin(
    owner.c,
    zeto.using(owner.c).createLock(owner.v, { from: owner.lookup, recipients: [{ to: to.v, amount: Number(amount), data: "0x" }], unlockData: "0x", data: "0x" }).id,
    ms
  );
  if (receipt?.success !== true) throw new Error(`createLock failed: ${receipt?.failureMessage ?? "no receipt"}`);
  let states: any[] = [];
  let lockId: string | undefined;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
    const sr = await owner.c.ptx.getStateReceipt(receipt.id);
    states = [...(sr?.confirmed ?? []), ...(sr?.info ?? [])];
    lockId = states.find((s: any) => s.data["lockId"])?.data["lockId"];
    if (lockId) break;
  }
  return { lockId: must(lockId, "lock id in the createLock state receipt"), receipt, states };
}

// Prepared (not sent) spendLock, re-encoded as the call the Atom will make (examples/swap encodeZetoTransfer).
// The outputs are pinned by createLock, so unlike V0 nothing else is chosen at prepare time.
export async function prepareSpend(zeto: ZetoInstance, owner: LockParty, lockId: string, ms = LONG_POLL_TIMEOUT): Promise<SpendLeg> {
  const txId = await zeto.using(owner.c).prepareSpendLock(owner.v, { lockId, from: owner.lookup, data: "0x" }).id;
  const prepared = must(await owner.c.pollForPreparedTransaction(txId, ms), "prepared spendLock");
  const abi = must(await owner.c.ptx.getStoredABI(prepared.transaction.abiReference ?? ""), "stored ABI").abi;
  const d = prepared.transaction.data as any;
  const iface = new ethers.Interface(abi);
  const encode = (spendArgs: string) => iface.encodeFunctionData("spendLock", [d.lockId, spendArgs, d.data]);
  return { lockId, call: encode(d.spendArgs), spendArgs: d.spendArgs, encode, states: [...(prepared.states.confirmed ?? []), ...(prepared.states.info ?? [])] };
}

// PUBLIC delegateLock on the pool: only the current spender (the createLock submitter, i.e. the owner's own
// eth key) may call it; `newSpender` becomes the only identity that can spendLock/cancelLock. txId must be
// unique per caller (examples/swap/src/index.ts:292-297).
export function delegateLock(zeto: ZetoInstance, p: LockParty, lockId: string, newSpender: string, ms = LONG_POLL_TIMEOUT) {
  const delegateArgs = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes32 txId)"], [[ethers.hexlify(ethers.randomBytes(32))]]);
  return receiptWithin(p.c, zeto.using(p.c).delegateLockV1(p.v, { lockId, delegateArgs, newSpender, data: "0x" }).id, ms);
}

// Reclaim = cancelLock: the locked coins go back to the owner as an unlocked coin (pre-pinned at createLock).
// Only the current spender can do it, so it fails once the lock is delegated to an Atom.
const CANCEL_LOCK_ABI = [
  { type: "function", name: "cancelLock", stateMutability: "nonpayable", outputs: [], inputs: [{ name: "lockId", type: "bytes32" }, { name: "from", type: "string" }, { name: "data", type: "bytes" }] },
];
export async function cancelLock(zeto: ZetoInstance, owner: LockParty, lockId: string, ms = LONG_POLL_TIMEOUT) {
  const id = await owner.c.ptx.sendTransaction({
    type: TransactionType.PRIVATE,
    abi: CANCEL_LOCK_ABI as any,
    function: "cancelLock",
    to: zeto.address,
    from: owner.lookup,
    data: { lockId, from: owner.lookup, data: "0x" },
  });
  return receiptWithin(owner.c, id, ms);
}

// Tamper the first pinned output of a prepared spend. The pool checks keccak(lockedInputs, lockedOutputs,
// outputs, data) against the spendCommitment fixed at createLock BEFORE it verifies the proof, so V1 reverts
// with InvalidUnlockHash where V0 reverted with "Invalid proof".
const SPEND_ARGS = "tuple(bytes32 txId, uint256[] lockedOutputs, uint256[] outputs, bytes proof, bytes data)";
export function tamperedCall(leg: SpendLeg): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [a] = coder.decode([SPEND_ARGS], leg.spendArgs);
  const outputs: bigint[] = Array.from(a.outputs as ArrayLike<bigint>);
  outputs[0] = outputs[0] + 1n;
  return leg.encode(coder.encode([SPEND_ARGS], [[a.txId, Array.from(a.lockedOutputs as ArrayLike<bigint>), outputs, a.proof, a.data]]));
}
