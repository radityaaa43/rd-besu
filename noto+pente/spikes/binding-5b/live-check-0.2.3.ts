/*
 * Task #6c live check: reuses the exact #5b scenario (spike.ts), but calls the PRODUCTIZED
 * paladin-client 0.2.3 method `verifyDelegatedLeg` directly (the real class method, not the
 * spike's own inline check function) -- proves the released capability behaves identically to
 * what was proven live in #5b: honest -> ok=true, attack -> ok=false.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node live-check-0.2.3.ts
 */
import PaladinClient, { INotoDomainReceipt, NotoFactory, PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { newERC20Tracker } from "../../bond/src/helpers/erc20tracker";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient } from "../../common/paladin-client/src/index";

const logger = console;
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};

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
  const [cashIssuer] = bi.getVerifiers(`b6cCashIssuer${runId}@${nodeConnections[0].id}`);
  const [buyer] = buyerClient.getVerifiers(`b6cBuyer${runId}@${nodeConnections[2].id}`);
  const [seller] = sellerClient.getVerifiers(`b6cSeller${runId}@${nodeConnections[1].id}`);
  const [biAtomStandIn] = bi.getVerifiers(`b6cAtom${runId}@${nodeConnections[0].id}`);

  logger.log("=== Deploying scratch hooks-mode cash token ===");
  const penteFactory = new PenteFactory(bi, "pente");
  const cashGroup = await penteFactory.newPrivacyGroup({ members: [cashIssuer], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!cashGroup) return false;
  const cashTracker = await newERC20Tracker(cashGroup, cashIssuer, { name: "B6CCASH", symbol: "B6C" });
  if (!cashTracker) return false;
  const notoCash = await new NotoFactory(bi, "noto")
    .newNoto(cashIssuer, {
      name: "B6CCASH",
      symbol: "B6C",
      notary: cashIssuer,
      notaryMode: "hooks",
      options: { hooks: { privateGroup: cashGroup, publicAddress: cashGroup.address, privateAddress: cashTracker.address } },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!notoCash) return false;
  logger.log(`notoCash=${notoCash.address}`);

  let r = await notoCash.mint(cashIssuer, { to: buyer, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!r?.success) return false;

  const prepareOnce = async (lockId: string, sellerAmount: number, changeAmount: number) =>
    notoCash
      .using(buyerClient)
      .prepareUnlock(buyer, {
        lockId,
        from: buyer,
        recipients: [
          { to: seller, amount: String(sellerAmount) },
          { to: buyer, amount: String(changeAmount) },
        ],
        unlockData: "0x",
        data: "0x",
      })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);

  let r2 = await notoCash.using(buyerClient).lock(buyer, { amount: "100", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
  if (!r2?.success) return false;
  const lockId = (r2.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.lockId;
  if (!lockId) return false;
  logger.log(`lockId=${lockId}`);

  // Honest terms, then the attack re-prepare (same shape as #5b), then delegate.
  await prepareOnce(lockId, 70, 30);
  const prep2 = await prepareOnce(lockId, 40, 60);
  const unlockCall2 = (prep2!.domainReceipt as INotoDomainReceipt).lockInfo!.unlockCall!;

  const atomAddr = await biAtomStandIn.address();
  const delegateReceipt = await notoCash.using(buyerClient).delegateLock(buyer, { lockId, delegate: atomAddr, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!delegateReceipt?.success) return false;

  // === The productized check, through the REAL paladin-client 0.2.3 method ===
  const biClient = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url,
    wsUrl: nodeConnections[0].clientOptions.url.replace(/^http/, "ws").replace(/(\d+)$/, (p) => String(Number(p) + 1)),
    nodeId: nodeConnections[0].id,
    identity: `b6cCashIssuer${runId}`, // same local name as cashIssuer above -- any node1 identity works for this read-only check
  });

  const sellerAddr = await seller.address();
  const buyerAddr = await buyer.address();

  const attackResult = await biClient.verifyDelegatedLeg(notoCash.address, lockId, unlockCall2, { recipient: sellerAddr, amount: "70", owner: buyerAddr });
  check("productized verifyDelegatedLeg REJECTS the attack (delegated call is 40, agreed was 70)", !attackResult.ok, JSON.stringify(attackResult));

  const honestResult = await biClient.verifyDelegatedLeg(notoCash.address, lockId, unlockCall2, { recipient: sellerAddr, amount: "40", owner: buyerAddr });
  check("productized verifyDelegatedLeg ACCEPTS when checked against the actually-delegated amount", honestResult.ok, JSON.stringify(honestResult));

  await biClient.disconnect();

  console.log(failures === 0 ? "\nSUCCESS: 0.2.3 verifyDelegatedLeg verified live via the real method" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
