import { ITransactionReceipt } from "@lfdecentralizedtrust/paladin-sdk";
import { LONG_POLL_TIMEOUT } from "paladin-example-common";
import { Platform, requireSuccess } from "./platform";
import { transferNoto } from "./transfer";

// RD issuance: the same mint call as index.ts (cashIssuer on node1 mints to the holder).
export async function issueCash(p: Platform, toLookup: string, amount: bigint, onSubmitted?: (txId: string) => void): Promise<ITransactionReceipt> {
  const [issuer, to] = p.node1.getVerifiers(p.data.participants.cashIssuer, toLookup);
  const tx = p.notoCash.mint(issuer, { to, amount: amount.toString(), data: "0x" });
  onSubmitted?.(await tx.id);
  return requireSuccess(await tx.waitForReceipt(LONG_POLL_TIMEOUT, true), "issue cash");
}

// DFABI issuance to a bank. BondTracker.onMint only accepts the custodian as recipient and only while the
// series is INITIALIZED/ACTIVE, so index.ts mints the supply to the custodian once and distributes it.
// Issuing to a bank is that distribution step: the custodian transfers units out of the issued supply
// (whitelist-checked, recorded as a sale against the open round by BondTracker.onTransfer).
export function issueBond(p: Platform, toLookup: string, amount: bigint, onSubmitted?: (txId: string) => void): Promise<ITransactionReceipt> {
  const custodian = { name: "bondCustodian", node: "node1", client: p.node1, verifier: p.bondCustodian };
  return transferNoto(p, "bond", custodian, toLookup, amount, onSubmitted);
}
