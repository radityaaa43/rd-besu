// Zeto flow helpers for the Lensa Privasi app, parameterised (no module globals). Same calls as
// spike-zeto-e2e.ts (lock/prepare/delegate/Atom/report), plus private mint.
// Never sends a PUBLIC tx to a Zeto contract: there is deliberately no issueToken/seed here,
// because both need setERC20 (the v1.0.0 poison pill, README). Issuance is private `mint`.
// Every wait is bounded by a real deadline: the SDK's pollForReceipt/pollForPreparedTransaction
// loop `waitMs` iterations of ~100 ms, so a "120000" there is hours.
import PaladinClient, {
  IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X,
  ITransactionReceipt,
  PaladinVerifier,
  PenteFactory,
  ZetoFactory,
  ZetoInstance,
  algorithmZetoSnarkBJJ,
} from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { AtomFactory } from "./atom";
import { REPORT_TOPIC, Report, buildReport } from "./bi-report";
import { LONG_POLL_TIMEOUT, nodeConnections } from "./common";

export { PaladinClient, PenteFactory, ZetoInstance, AtomFactory, nodeConnections, IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X, algorithmZetoSnarkBJJ };
export { newAtomFactory } from "./atom";
export { BiLedger, chainIO } from "./bi-report";
export type { Report };

export type Party = { lookup: string; c: PaladinClient; v: PaladinVerifier };
export type Settled = { receipt: ITransactionReceipt; publicAt: number; receiptAt: number; startedAt: number };
export type Leg = { utxo: string; call: string; outputs: string[]; states: any[]; lockRcpt: ITransactionReceipt };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const must = <V>(v: V | undefined | null, what: string): V => {
  if (v === undefined || v === null) throw new Error(`${what} missing`);
  return v;
};

export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} tidak selesai dalam ${ms / 1000} detik`)), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

export function party(clients: PaladinClient[], lookup: string): Party {
  const c = clients[Number(lookup.split("@node")[1]) - 1];
  return { lookup, c, v: c.getVerifiers(lookup)[0] };
}

// Wait for a submitted tx with a real deadline. `publicAt` is the closest observable boundary of
// "proof built + sent on": the base-ledger public tx appears in getTransactionFull(id).public only
// after assembly, proof and endorsement. If the receipt shows up first, publicAt = receiptAt.
export async function settle(c: PaladinClient, fut: { id: string | Promise<string> }, what = "tx", ms = LONG_POLL_TIMEOUT): Promise<Settled> {
  const startedAt = Date.now();
  const id = await within(Promise.resolve(fut.id), ms, `${what}: kirim`);
  let publicAt = 0;
  while (Date.now() - startedAt < ms) {
    const receipt = await c.ptx.getTransactionReceipt(id);
    if (receipt != null) {
      const receiptAt = Date.now();
      if (receipt.success !== true) throw new Error(`${what} gagal: ${receipt.failureMessage ?? "tanpa pesan"}`);
      return { receipt, publicAt: publicAt || receiptAt, receiptAt, startedAt };
    }
    if (!publicAt && ((await c.ptx.getTransactionFull(id))?.public?.length ?? 0) > 0) publicAt = Date.now();
    await sleep(250);
  }
  throw new Error(`${what}: tidak ada receipt dalam ${ms / 1000} detik (tx ${id})`);
}

// Fresh Zeto_Anon owned by `issuer`. Private from the start: no ERC20, no setERC20.
export async function deployToken(issuer: Party): Promise<ZetoInstance> {
  const zeto = await new ZetoFactory(issuer.c, "zeto").newZeto(issuer.v, { tokenName: "Zeto_Anon" }).waitForDeploy(LONG_POLL_TIMEOUT);
  return must(zeto, "Zeto deploy");
}

// Private mint by the token's deployer: one UTXO per entry, at most 10 outputs per mint tx.
export async function mintUtxos(issuer: Party, zeto: ZetoInstance, to: Party, count: number, amount: bigint): Promise<Settled[]> {
  const out: Settled[] = [];
  for (let left = count; left > 0; left -= 10) {
    const mints = Array.from({ length: Math.min(10, left) }, () => ({ to: to.v, amount: Number(amount), data: "0x" }));
    out.push(await settle(issuer.c, zeto.using(issuer.c).mint(issuer.v, { mints }), `mint untuk ${to.lookup}`));
  }
  return out;
}

export const transfer = (from: Party, zeto: ZetoInstance, to: Party, amount: number) =>
  settle(from.c, zeto.using(from.c).transfer(from.v, { transfers: [{ to: to.v, amount, data: "0x" }] }), `transfer ${from.lookup}`);

// Bank reports the outputs it holds plaintext for to BI over its privacy group; resolves once the
// node has accepted the message. `known`: states in hand that the node does not index (prepared legs).
export async function reportTo(group: string, from: Party, token: "RD" | "DFABI", zetoAddress: string, receipt: ITransactionReceipt, known: any[] = []): Promise<Report> {
  const rep = await buildReport(from.c, from.lookup, token, zetoAddress, must(receipt.transactionHash, "txHash"), known);
  await from.c.pgroup.sendMessage({ domain: "pente", group, topic: REPORT_TOPIC, data: rep });
  return rep;
}

export async function newGroup(bank: Party, bi: Party, name: string): Promise<string> {
  const g = await new PenteFactory(bank.c, "pente").newPrivacyGroup({ name, members: [bank.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT);
  return must(g, "privacy group").group.id;
}

// ---- DvP: Zeto lock + prepare per leg, one Atom to execute both (examples/swap) ----

async function lock(zeto: ZetoInstance, owner: Party, amount: bigint) {
  const { receipt } = await settle(owner.c, zeto.using(owner.c).lock(owner.v, { amount: Number(amount), delegate: await owner.v.address() }), `lock ${owner.lookup}`);
  let utxo: string | undefined;
  for (const start = Date.now(); !utxo && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(1000)) utxo = (await owner.c.ptx.getStateReceipt(receipt.id))?.confirmed?.find((s: any) => s.data["locked"])?.id;
  return { receipt, utxo: must(utxo, "locked state") };
}

async function leg(zeto: ZetoInstance, owner: Party, to: Party, amount: bigint): Promise<Leg> {
  const l = await lock(zeto, owner, amount);
  const txId = await within(Promise.resolve(zeto.using(owner.c).prepareTransferLocked(owner.v, { lockedInputs: [l.utxo], delegate: owner.lookup, transfers: [{ to: to.v, amount: Number(amount), data: "0x" }] }).id), LONG_POLL_TIMEOUT, "prepareTransferLocked: kirim");
  const prepared = must(await within(owner.c.pollForPreparedTransaction(txId, LONG_POLL_TIMEOUT), LONG_POLL_TIMEOUT, "prepareTransferLocked"), "prepared transferLocked");
  const abi = must(await owner.c.ptx.getStoredABI(prepared.transaction.abiReference ?? ""), "stored ABI").abi;
  const d = prepared.transaction.data as any;
  const call = new ethers.Interface(abi).encodeFunctionData("transferLocked", [d.inputs, d.outputs, d.proof, d.data]);
  return { utxo: l.utxo, call, outputs: d.outputs as string[], states: prepared.states.confirmed ?? [], lockRcpt: l.receipt };
}

// Seller delivers `units` of `bond`; buyer pays units * price of `cash`. The Atom is created by the
// seller and executed by the buyer (public txs to the Atom contracts, never to a Zeto contract).
export async function swap(f: AtomFactory, seller: Party, buyer: Party, bond: ZetoInstance, cash: ZetoInstance, units: number, price: number) {
  const bondLeg = await leg(bond, seller, buyer, BigInt(units));
  const cashLeg = await leg(cash, buyer, seller, BigInt(units) * BigInt(price));
  const atom = must(await f.using(seller.c).create(seller.v, [
    { contractAddress: bond.address, callData: bondLeg.call },
    { contractAddress: cash.address, callData: cashLeg.call },
  ]), "Atom");
  for (const [z, p, l] of [[bond, seller, bondLeg], [cash, buyer, cashLeg]] as const) {
    await settle(p.c, z.using(p.c).delegateLock(p.v, { utxos: [l.utxo], delegate: atom.address }), `delegateLock ${p.lookup}`);
  }
  const execAt = Date.now();
  const receipt = must(await within(atom.using(buyer.c).execute(buyer.v), LONG_POLL_TIMEOUT, "Atom execute"), "Atom receipt");
  if (receipt.success !== true) throw new Error(`Atom execute gagal: ${receipt.failureMessage ?? "tanpa pesan"}`);
  return { atom, exec: { receipt, publicAt: execAt, receiptAt: Date.now(), startedAt: execAt } as Settled, bond: bondLeg, cash: cashLeg };
}

// Unlocked states a node holds for `account`, as {id, amount}; used by load capacity and lenses.
export async function heldStates(c: PaladinClient, zetoAddress: string, status: "available" | "all" = "available", limit = 1000) {
  const schema = must((await c.pstate.listSchemas("zeto")).find((s: any) => /ZetoCoin/.test(s.signature ?? "")), "ZetoCoin schema");
  return (await c.pstate.queryContractStates("zeto", zetoAddress, schema.id, { limit } as any, status)) as { id: string; data: { amount: string; owner: string; locked?: boolean } }[];
}

export async function stateCount(c: PaladinClient, zetoAddress: string) {
  return (await heldStates(c, zetoAddress, "all")).length;
}
