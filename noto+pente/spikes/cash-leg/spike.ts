/*
 * Spike for lead task: can BI (cashIssuer@node1, notary of the CBDC/cash Noto token)
 * verify the REAL amount+recipient of a buyer-submitted cash leg, from BI's own node,
 * WITHOUT submitting the transaction itself and WITHOUT trusting unlockCall (state hashes only)?
 *
 * Evidence this should work, found by reading the Paladin repo (not guessed):
 * - domains/noto/internal/noto/handler_unlock_common.go:183-187 (assembleUnlockOutputs_V1):
 *     for every prepareUnlock recipient, `distribution = identityList{notaryID, fromID, toID}`
 *     and the output Coin state (owner=recipient, amount=cleartext) is sent to that list.
 *   => the notary ALWAYS receives a cleartext copy of the prepared recipient+amount,
 *      regardless of which node submitted the transaction.
 * - domains/noto/pkg/types/states.go:74-89 (NotoCoinABI): the Coin's owner+amount fields
 *   are plain (not hashed/encrypted) in the state data BI's node stores.
 *
 * This script: deploys a scratch hooks-mode cash token (own factory/group/tracker, own
 * contract-data, nothing shared with Paladin/bond's live series), has "buyer" (node3) lock
 * and prepareUnlock cash to "seller" (node2) twice -- once at the AGREED amount, once at a
 * WRONG amount -- then, from node1 (BI, the notary), queries pstate_queryStates for the
 * resulting Coin and compares it against the agreed trade terms.
 *
 * Run: NODE_PATH=../../bond/node_modules ../../bond/node_modules/.bin/ts-node spike.ts
 */
import PaladinClient, {
  INotoDomainReceipt,
  NotoFactory,
  PenteFactory,
} from "@lfdecentralizedtrust/paladin-sdk";
import { newERC20Tracker } from "../../bond/src/helpers/erc20tracker";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";

const logger = console;
const AGREED_UNITS = 10;
const AGREED_PRICE = 2.1; // not a whole number on its own; the AGREED consideration below is what BI checks
const AGREED_CONSIDERATION = 21; // units(10) x price(2.1) -- this is the number BI must see appear, in cleartext

async function main(): Promise<boolean> {
  if (nodeConnections.length < 4) {
    logger.error("Need 4 nodes configured.");
    return false;
  }
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const bi = clients[0]; // BI's own node -- everything BI does below uses ONLY this client
  const buyerClient = clients[2]; // node3
  const sellerClient = clients[1]; // node2

  // fresh identity names per run: otherwise BI's state query below would also surface stale
  // Coin states left over by earlier runs of this script (same owner address = same bip32 key).
  const runId = Date.now();
  const [cashIssuer] = bi.getVerifiers(`biCashIssuer@${nodeConnections[0].id}`);
  const [buyer] = buyerClient.getVerifiers(`spikeBuyer${runId}@${nodeConnections[2].id}`);
  const [seller] = sellerClient.getVerifiers(`spikeSeller${runId}@${nodeConnections[1].id}`);

  logger.log("=== Deploying scratch hooks-mode cash token (BI is notary) ===");
  const penteFactory = new PenteFactory(bi, "pente");
  const cashGroup = await penteFactory
    .newPrivacyGroup({ members: [cashIssuer], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashGroup) return fail("cash group deploy failed");
  const cashTracker = await newERC20Tracker(cashGroup, cashIssuer, { name: "SPIKECASH", symbol: "SPC" });
  if (!cashTracker) return fail("cash tracker deploy failed");
  const notoCash = await new NotoFactory(bi, "noto")
    .newNoto(cashIssuer, {
      name: "SPIKECASH",
      symbol: "SPC",
      notary: cashIssuer,
      notaryMode: "hooks",
      options: { hooks: { privateGroup: cashGroup, publicAddress: cashGroup.address, privateAddress: cashTracker.address } },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!notoCash) return fail("noto cash deploy failed");
  logger.log(`notoCash=${notoCash.address} cashGroup=${cashGroup.address}`);

  logger.log("\n=== BI mints enough cash to buyer (own issuer action, submitted by BI) ===");
  let receipt = await notoCash
    .mint(cashIssuer, { to: buyer, amount: 1000, data: "0x" })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!receipt?.success) return fail("mint failed");
  logger.log(`mint tx=${receipt.id} hash=${receipt.transactionHash}`);

  // Find BI's own view of the "Coin" (unlocked output) schema id -- BI never submitted
  // the prepareUnlock transactions below; this listSchemas call proves BI's node has the
  // schema registered at all (a prerequisite for BI to later query states against it).
  const schemas = await bi.pstate.listSchemas("noto");
  const coinSchema = schemas.find((s) => (s.definition as { name?: string }).name === "NotoCoin");
  if (!coinSchema) return fail(`NotoCoin schema not found on BI's node (saw: ${schemas.map((s) => (s.definition as any).name)})`);
  logger.log(`BI's own NotoCoin schema id: ${coinSchema.id}`);

  const lockAndPrepare = async (amount: number, label: string) => {
    logger.log(`\n=== [${label}] buyer locks+prepares ${amount} to seller (submitted from buyer's node, node3) ===`);
    let r = await notoCash
      .using(buyerClient)
      .lock(buyer, { amount: String(amount), data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!r?.success) throw new Error(`${label}: lock failed`);
    logger.log(`  lock tx=${r.id} hash=${r.transactionHash}`);
    const lockId = (r.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.lockId;
    if (!lockId) throw new Error(`${label}: no lockId`);

    r = await notoCash
      .using(buyerClient)
      .prepareUnlock(buyer, { lockId, from: buyer, recipients: [{ to: seller, amount: String(amount) }], unlockData: "0x", data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!r?.success) throw new Error(`${label}: prepareUnlock failed`);
    logger.log(`  prepareUnlock tx=${r.id} hash=${r.transactionHash}`);
    // unlockCall is ALL the seller/BI would see over the ledger: just hashes.
    const unlockCall = (r.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.unlockCall;
    logger.log(`  unlockCall (seller/BI cannot read an amount from this): ${unlockCall?.slice(0, 42)}...`);
    return { lockId, txId: r.id, txHash: r.transactionHash };
  };

  // BI's verification: query its OWN node for every NotoCoin owned by seller, newest first,
  // and read the cleartext amount -- BI submitted none of the transactions that produced this state.
  // Scoped to THIS contract (notoCash.address) -- without this, queryStates would mix in
  // Coin states this owner holds under any OTHER Noto contract sharing the same "NotoCoin"
  // schema (confirmed live: an earlier version of this script, filtering only by owner, picked
  // up leftover states from a previous run's own different scratch deployment).
  // This still only proves the mechanism, not a production-ready check: a real OutrightTrade.sol
  // must correlate against the SPECIFIC prepareUnlock (e.g. by lockId/salt reported through the
  // group), not just "does a coin of the right amount exist for this owner on this contract" --
  // a seller who has been paid the same amount before, on the same contract, would otherwise
  // produce a false MATCH for an unrelated/wrong leg. Flagged as open work in the report.
  const biVerify = async (expected: number, label: string): Promise<{ seen: number[]; match: boolean }> => {
    const sellerAddr = await seller.address();
    const states = await bi.pstate.queryContractStates("noto", notoCash.address, coinSchema.id, { eq: [{ field: "owner", value: sellerAddr }] }, "all");
    logger.log(`  [${label}] BI's own query, raw states: ${JSON.stringify(states.map((s) => ({ id: s.id, data: s.data })))}`);
    const amounts = states.map((s) => Number((s.data as { amount: string }).amount)).sort((a, b) => a - b);
    const match = amounts.length === 1 && amounts[0] === expected;
    logger.log(`  [${label}] BI's own query sees seller Coin amount(s)=[${amounts.join(",")}] expected=${expected} -> ${match ? "MATCH" : "MISMATCH"}`);
    return { seen: amounts, match };
  };

  const correct = await lockAndPrepare(AGREED_CONSIDERATION, "CORRECT");
  await sleep(2000); // state distribution is async; same margin already proven in Paladin/bond's rollback spike
  const correctResult = await biVerify(AGREED_CONSIDERATION, "CORRECT");

  const WRONG_AMOUNT = AGREED_CONSIDERATION - 11; // buyer tries to pay less than agreed
  const wrong = await lockAndPrepare(WRONG_AMOUNT, "WRONG");
  await sleep(2000);
  const wrongResult = await biVerify(AGREED_CONSIDERATION, "WRONG");

  logger.log("\n=== Result ===");
  logger.log(`CORRECT case: BI verification ${correctResult.match ? "PASSED (as expected)" : "FAILED (unexpected!)"} (tx ${correct.txId})`);
  logger.log(`WRONG case:   BI verification ${!wrongResult.match ? "REJECTED (as expected)" : "FAILED TO REJECT (unexpected!)"} (tx ${wrong.txId}, BI saw [${wrongResult.seen.join(",")}] vs agreed ${AGREED_CONSIDERATION})`);

  const ok = correctResult.match && !wrongResult.match;
  logger.log(ok ? "\nSUCCESS: candidate A verification mechanism works" : "\nFAILED: see above");
  return ok;
}

function fail(msg: string): false {
  logger.error(msg);
  return false;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
