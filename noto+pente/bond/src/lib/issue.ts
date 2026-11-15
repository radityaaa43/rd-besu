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

// DFABI issuance BI -> BI (user 2026-11-15: "untuk dfabi hanya bi ke bi dulu lalu baru awarding bi ke bank"): a new tranche into
// the custodian's stock, which the award (outright.ts) then sells to a bank. BondTracker (fork task #7, tap issuance) mints only once
// the open round has ended (private INITIALIZED/ACTIVE) and a round sells only its own tranche, so the open round is ended, its unsold
// units are burned and minted back with `amount`: the reopened round sells unsold + amount at the same price and denomination.
export type ReissueStep = "forceComplete" | "burnUnsold" | "close" | "activate" | "mint" | "begin";
export const reissuePlan = (unsold: bigint): ReissueStep[] =>
  [...(unsold > 0n ? (["forceComplete", "burnUnsold"] as const) : []), "close", "activate", "mint", "begin"];

// ponytail: not resumable; a failed step throws `reissue <step>` and the series stays where that step left it (read the public
// tracker's status() and finish the remaining steps by hand). Lensa runs one tx at a time, so no award lock is open meanwhile.
export async function reissueBond(p: Platform, amount: bigint, onSubmitted?: (txId: string) => void): Promise<ITransactionReceipt> {
  const custodian = p.bondCustodian;
  const [issuer] = p.node1.getVerifiers(p.data.participants.bondIssuer);
  const read = async (fn: string) => BigInt((await p.bondTracker.call({ from: custodian.lookup, function: fn }))[0]);
  const unsold = await read("availableUnitsPrivate");
  const terms = { discountPrice: String(await read("discountPrice")), minimumDenomination: String(await read("minimumDenomination")) };
  const send = (s: ReissueStep) => {
    switch (s) {
      case "forceComplete": return p.bondTracker.sendTransaction({ from: custodian.lookup, function: "forceCompleteDistribution" });
      case "burnUnsold": return p.notoBond.burn(custodian, { amount: unsold.toString(), data: "0x" });
      case "close": return p.bondTracker.sendTransaction({ from: custodian.lookup, function: "closeDistribution" });
      case "activate": return p.bondTracker.sendTransaction({ from: issuer.lookup, function: "setActive" });
      case "mint": return p.notoBond.mint(issuer, { to: custodian, amount: (unsold + amount).toString(), data: "0x" });
      case "begin": return p.bondTracker.beginDistribution(custodian, terms);
    }
  };
  let minted: ITransactionReceipt | undefined;
  for (const s of reissuePlan(unsold)) {
    const tx = send(s);
    if (s === "mint") onSubmitted?.(await tx.id);
    const r = requireSuccess(await tx.waitForReceipt(LONG_POLL_TIMEOUT, true), `reissue ${s}`);
    if (s === "mint") minted = r;
  }
  return minted!;
}
