import { ITransactionReceipt } from "@lfdecentralizedtrust/paladin-sdk";
import { LONG_POLL_TIMEOUT } from "paladin-example-common";
import { Participant, Platform, requireSuccess } from "./platform";

// Plain bank-to-bank Noto transfer (cash = RD, bond = DFABI); the notary on node1 endorses it and the
// token's hook (NotoTrackerERC20 / BondTracker whitelist) runs inside its Pente group.
// `onSubmitted` fires once the sender's node accepted the transaction (step timing for callers).
export async function transferNoto(
  p: Platform,
  token: "cash" | "bond",
  from: Participant,
  toLookup: string,
  amount: bigint,
  onSubmitted?: (txId: string) => void
): Promise<ITransactionReceipt> {
  const noto = (token === "cash" ? p.notoCash : p.notoBond).using(from.client);
  const [to] = from.client.getVerifiers(toLookup);
  const tx = noto.transfer(from.verifier, { to, amount: amount.toString(), data: "0x" });
  onSubmitted?.(await tx.id);
  return requireSuccess(await tx.waitForReceipt(LONG_POLL_TIMEOUT, true), `transfer ${token}`);
}
