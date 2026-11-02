import PaladinClient from "@lfdecentralizedtrust/paladin-sdk";
import INoto from "@lfdecentralizedtrust/paladin-sdk/build/domains/abis/INoto.json";
import type { Participant, Platform } from "./platform";

// Per-node reads of one Noto transaction, for callers (the Lensa Privasi adapter) that must not import the SDK.

// Unlock/spend tx ids on chain are 32 bytes (UUID + 16 zero bytes); ptx_* methods take the UUID.
export function txUuid(id: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(id)) return id;
  const h = id.slice(2, 34);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface NotoTxView {
  visible: boolean; // this node holds the private state of the tx
  amount?: bigint; // sum of the transfers the node can see
  parties: string[]; // from / to / sender addresses or lookups the node can see, lower-cased
  from: string[]; // senders of the transfers the node can see, lower-cased; empty for a mint, and for a DvP leg whose locked inputs the node cannot read
  to: string[]; // recipients of the transfers the node can see, lower-cased
  sender?: string; // the domain receipt's sender (the minter, or the owner of the lock), lower-cased
  spenders: string[]; // owners of the (locked) input states the node holds, lower-cased
  receivers: string[]; // owners of the output states the node holds that are not spenders (change excluded)
  hidden: string[]; // state ids the node knows exist but cannot read
}

// What `client`'s own node can read about `txId`. A node without the private data (an outsider) gets no domain
// receipt (PD011658) and only the ids of the states in its state receipt. A node that merely knows an INPUT coin it
// created earlier gets a domain receipt with inputs but no outputs: it learns nothing of this transfer, so it is
// not "visible". Visible = the node can read the tx's output states.
// Only PD011658 ("none of the private state data is available on the local node") counts as the node's refusal;
// any other error (node down, unknown tx, ...) propagates, so a failed read is never mistaken for "sealed".
// `hidden` non-empty (with visible false) = the node's state receipt positively lists states it knows exist but cannot read.
export async function readNotoTx(client: PaladinClient, txId: string): Promise<NotoTxView> {
  const id = txUuid(txId);
  const dom = await client.ptx.getDomainReceipt("noto", id).catch((e: unknown) => {
    if (!String((e as Error)?.message ?? e).includes("PD011658")) throw e;
    return undefined;
  });
  if (dom?.transfers && dom.states?.outputs?.length) {
    const transfers: { from?: string; to?: string; amount: string }[] = dom.transfers;
    const owners = (xs?: { data: { owner: string } }[]) => [...new Set((xs ?? []).map((x) => x.data.owner.toLowerCase()))];
    const spenders = [...new Set([...owners(dom.states.inputs), ...owners(dom.states.lockedInputs)])];
    return {
      visible: true,
      amount: transfers.reduce((sum, t) => sum + BigInt(t.amount), 0n),
      parties: [...transfers.flatMap((t) => [t.from, t.to]), dom.sender].filter((x): x is string => !!x).map((x) => x.toLowerCase()),
      from: [...new Set(transfers.map((t) => t.from).filter((x): x is string => !!x).map((x) => x.toLowerCase()))],
      to: [...new Set(transfers.map((t) => t.to).filter((x): x is string => !!x).map((x) => x.toLowerCase()))],
      sender: dom.sender?.toLowerCase(),
      spenders,
      receivers: owners(dom.states.outputs).filter((o) => !spenders.includes(o)),
      hidden: [],
    };
  }
  const st = await client.ptx.getStateReceipt(id);
  const u = st?.unavailable ?? {};
  return { visible: false, parties: [], from: [], to: [], spenders: [], receivers: [], hidden: [...(u.confirmed ?? []), ...(u.spent ?? []), ...(u.info ?? [])] };
}

// The node answered, but has no receipt for the tx (yet). Any other error from a read is a real failure.
export class NotIndexedError extends Error {}

// Base-ledger hash and block of a tx (every node has this, outsiders included).
export async function readTxReceipt(client: PaladinClient, txId: string): Promise<{ txHash: string; block: number }> {
  const r = await client.ptx.getTransactionReceipt(txUuid(txId));
  if (!r?.transactionHash) throw new NotIndexedError(`no receipt for ${txId}`);
  return { txHash: r.transactionHash, block: r.blockNumber };
}

// Waits until `client`'s own node has indexed the tx (its receipt is readable). On timeout throws `Error(onTimeout)`
// if the node kept answering "no receipt", or the real error (e.g. ECONNREFUSED) if reads failed for another reason.
export async function waitTxIndexed(client: PaladinClient, txId: string, timeoutMs: number, onTimeout: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readTxReceipt(client, txId);
      return;
    } catch (e) {
      if (Date.now() > end) {
        if (e instanceof NotIndexedError) throw new Error(`${onTimeout} (${e.message})`);
        throw e;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Spent/created state hashes the base ledger shows for a tx, decoded from its events as seen by `client`'s node.
export async function readStateHashes(client: PaladinClient, txHash: string): Promise<{ inputs: string[]; outputs: string[] }> {
  const events = await client.bidx.decodeTransactionEvents(txHash, INoto.abi, "");
  return {
    inputs: events.flatMap((e: { data: { inputs?: string[] } }) => e.data?.inputs ?? []),
    outputs: events.flatMap((e: { data: { outputs?: string[] } }) => e.data?.outputs ?? []),
  };
}

// Spend tx ids of a settled outright trade's two legs (bond unlock, cash unlock). Both execute inside the one
// atom tx, so they share a base-ledger hash. Mirrors the idempotency keys of outright.ts (bond prepared on the
// seller's node, cash on the buyer's).
export async function tradeSpendTxIds(p: Platform, tradeId: string, seller: Participant, buyer: Participant): Promise<{ bond: string; cash: string }> {
  const spendOf = async (who: Participant, step: string) => {
    const tx = await who.client.ptx.getTransactionByIdempotencyKey(`${p.notoBond.address}-${tradeId}-${step}`);
    const id = (await who.client.ptx.getTransactionReceiptFull(tx.id))?.domainReceipt?.lockInfo?.spendTxId;
    if (!id) throw new Error(`${step}: no spendTxId in receipt`);
    return id as string;
  };
  return { bond: await spendOf(seller, "bond-prepare-unlock"), cash: await spendOf(buyer, "cash-prepare-unlock") };
}

// Calls `onDispatch` once the sender's node reports the notary (node1) picked the tx up (first sequencerActivity entry).
// Returns a stop function. Closest boundary the SDK exposes for "notary checked".
export function watchDispatch(client: PaladinClient, txId: string, onDispatch: () => void): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const tx = await client.ptx.getTransactionFull(txId).catch(() => undefined);
      if (tx?.sequencerActivity?.length) {
        if (!stopped) {
          try { onDispatch(); } catch { /* the callback emits steps; its throw must not become an unhandled rejection */ }
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return () => { stopped = true; };
}
