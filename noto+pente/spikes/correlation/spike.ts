/*
 * Spike for lead task #3 part B: prove BI can distinguish two prepared cash-leg states that
 * share the SAME owner (seller) and the SAME amount, by correlating against a SPECIFIC leg --
 * not by amount alone (the bare-amount gap the cash-leg spike already found, 2026-10-05:
 * docs/superpowers/sdd/2026-10-05-cash-leg-spike.md).
 *
 * Two mechanisms were tried, in order (both findings, kept for the record):
 * 1. REJECTED (proven live, first run of this file): correlate via IState.confirmed.transaction /
 *    .read.transaction from `pstate_queryContractStates`. Neither field is populated on the
 *    objects that endpoint actually returns (confirmed via a raw JSON dump) -- so this is not
 *    a viable key, contrary to what the OutrightTrade.sol design doc first assumed.
 * 2. USED (proven below): the prepareUnlock call's OWN receipt already names the exact resulting
 *    state. `receipt.domainReceipt.states.preparedOutputs[]` (confirmed live via a full-receipt
 *    probe) is a list of `{id, schema, data: {amount, owner, salt}}` entries -- `id` is the
 *    state's own content-addressed identifier. Filtering that list for the entry whose
 *    `data.owner` matches the recipient gives the state's `id` directly from the leg owner's own
 *    receipt, with zero extra RPC calls. Recording THAT id on-chain (not `lockId`, which only
 *    appears on the LOCKED/input coin -- domains/noto/pkg/types/states.go:98-103 -- never on the
 *    output) is the correlation key BI's later query matches against.
 *
 * Run: NODE_PATH=../../bond/node_modules ../../bond/node_modules/.bin/ts-node spike.ts
 */
import PaladinClient, { INotoDomainReceipt, NotoFactory, PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { newERC20Tracker } from "../../bond/src/helpers/erc20tracker";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";

const logger = console;
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<boolean> {
  if (nodeConnections.length < 4) {
    logger.error("Need 4 nodes configured.");
    return false;
  }
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const bi = clients[0];
  const buyerClient = clients[2];
  const sellerClient = clients[1];
  const runId = Date.now();
  const [cashIssuer] = bi.getVerifiers(`biCashIssuer${runId}@${nodeConnections[0].id}`);
  const [buyer] = buyerClient.getVerifiers(`corrBuyer${runId}@${nodeConnections[2].id}`);
  const [seller] = sellerClient.getVerifiers(`corrSeller${runId}@${nodeConnections[1].id}`);

  logger.log("=== Deploying scratch hooks-mode cash token (BI is notary) ===");
  const penteFactory = new PenteFactory(bi, "pente");
  const cashGroup = await penteFactory
    .newPrivacyGroup({ members: [cashIssuer], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashGroup) return false;
  const cashTracker = await newERC20Tracker(cashGroup, cashIssuer, { name: "CORRCASH", symbol: "CORR" });
  if (!cashTracker) return false;
  const notoCash = await new NotoFactory(bi, "noto")
    .newNoto(cashIssuer, {
      name: "CORRCASH",
      symbol: "CORR",
      notary: cashIssuer,
      notaryMode: "hooks",
      options: { hooks: { privateGroup: cashGroup, publicAddress: cashGroup.address, privateAddress: cashTracker.address } },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!notoCash) return false;
  logger.log(`notoCash=${notoCash.address}`);

  let receipt = await notoCash.mint(cashIssuer, { to: buyer, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!receipt?.success) return false;

  const schemas = await bi.pstate.listSchemas("noto");
  const coinSchema = schemas.find((s) => (s.definition as { name?: string }).name === "NotoCoin");
  if (!coinSchema) {
    logger.error("NotoCoin schema not found on BI's node");
    return false;
  }

  // Two independent locks, SAME amount, SAME recipient -- the exact ambiguity the lead asked for.
  const AMOUNT = 50;
  const lockAndPrepare = async (label: string) => {
    let r = await notoCash
      .using(buyerClient)
      .lock(buyer, { amount: String(AMOUNT), data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!r?.success) throw new Error(`${label}: lock failed`);
    const lockId = (r.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.lockId;
    if (!lockId) throw new Error(`${label}: no lockId`);

    r = await notoCash
      .using(buyerClient)
      .prepareUnlock(buyer, { lockId, from: buyer, recipients: [{ to: seller, amount: String(AMOUNT) }], unlockData: "0x", data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!r?.success) throw new Error(`${label}: prepareUnlock failed`);
    const sellerAddr = await seller.address();
    const preparedOutputs = (r.domainReceipt as any)?.states?.preparedOutputs as { id: string; data: { owner: string; amount: string } }[] | undefined;
    const ourOutput = preparedOutputs?.find((o) => o.data.owner.toLowerCase() === sellerAddr.toLowerCase());
    if (!ourOutput) throw new Error(`${label}: no preparedOutputs entry for seller in receipt`);
    logger.log(`[${label}] lockId=${lockId} preparedOutput.id=${ourOutput.id} amount=${ourOutput.data.amount}`);
    return { lockId, preparedStateId: ourOutput.id };
  };

  const leg1 = await lockAndPrepare("leg1");
  const leg2 = await lockAndPrepare("leg2");
  await sleep(2000);

  const sellerAddr = await seller.address();
  const states = await bi.pstate.queryContractStates("noto", notoCash.address, coinSchema.id, { eq: [{ field: "owner", value: sellerAddr }] }, "all");
  logger.log(`\nBI's own query (owner=seller, this contract only): ${states.length} state(s)`);
  for (const s of states) {
    logger.log(`  raw: ${JSON.stringify(s)}`);
  }
  check("two distinct same-amount states exist", states.length === 2 && states.every((s) => (s.data as { amount: string }).amount === String(AMOUNT)), `count=${states.length}, amounts=[${states.map((s) => (s.data as any).amount).join(",")}]`);

  // Correlation key: the exact state id from the leg's own prepareUnlock receipt
  // (domainReceipt.states.preparedOutputs[].id), not amount, not lockId, not a transaction id.
  const matchFor = (preparedStateId: string) => states.filter((s) => s.id === preparedStateId);

  const m1 = matchFor(leg1.preparedStateId);
  const m2 = matchFor(leg2.preparedStateId);
  check("leg1's prepared state id resolves to exactly 1 state", m1.length === 1, `matches=${m1.length}`);
  check("leg2's prepared state id resolves to exactly 1 state", m2.length === 1, `matches=${m2.length}`);
  check("leg1 and leg2 resolve to DIFFERENT states (not the same one twice)", m1.length === 1 && m2.length === 1 && m1[0].id !== m2[0].id, `leg1->${m1[0]?.id}, leg2->${m2[0]?.id}`);

  const bogusStateId = "0x" + "ab".repeat(32); // well-formed 32-byte hash shape, never actually produced
  const mBogus = matchFor(bogusStateId);
  check("a state id that was never produced resolves to 0 states", mBogus.length === 0, `matches=${mBogus.length}`);

  // Negative control: confirm the OLD (rejected) mechanism really is unusable -- both legs'
  // IState envelopes from the query have no confirmed/read transaction linkage.
  check("confirmed/read.transaction are NOT populated (confirms mechanism 1 is rejected, not just untried)", states.every((s: any) => !s.confirmed && !s.read), JSON.stringify(states.map((s: any) => ({ confirmed: s.confirmed, read: s.read }))));

  console.log(failures === 0 ? "\nSUCCESS: correlation-key checks passed" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
