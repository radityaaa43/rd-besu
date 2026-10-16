import { parseArgs } from "util";
import { getCachePath } from "paladin-example-common";
import { appendTrade, loadPlatform, loadTrades } from "./lib/platform";
import { TradeRejected, executeOutright, recoverTrade } from "./lib/outright";

const USAGE =
  "usage: npm run outright -- --seller <investorN> --buyer <investorN> --units <int> --price <decimal> [--trade-id <id>]\n" +
  "       npm run outright -- --recover <tradeId>   (release open locks of a FAILED trade)";

async function main(): Promise<boolean> {
  const { values } = parseArgs({
    options: {
      seller: { type: "string" },
      buyer: { type: "string" },
      units: { type: "string" },
      price: { type: "string" },
      "trade-id": { type: "string" },
      recover: { type: "string" },
      cache: { type: "string" },
    },
  });
  if (values.recover) {
    const platform = await loadPlatform(getCachePath());
    const trade = loadTrades(platform.dataDir, platform.data.notoBondAddress).find((t) => t.tradeId === values.recover);
    if (!trade) {
      console.error(`trade ${values.recover} not found for bond ${platform.data.notoBondAddress}`);
      return false;
    }
    try {
      const recovered = await recoverTrade(platform, trade);
      appendTrade(platform.dataDir, recovered);
      if (recovered.status !== "ROLLED_BACK") {
        console.error(`Recovery failed: ${recovered.rollbackError}`);
        return false;
      }
      console.log(`ROLLED_BACK: trade ${trade.tradeId} locks released (cancel atom ${recovered.rollbackAtomAddress})`);
      return true;
    } catch (err) {
      if (err instanceof TradeRejected) {
        console.error(`REJECTED: ${err.message}`);
        return false;
      }
      throw err;
    }
  }
  if (!values.seller || !values.buyer || !values.units || !values.price) {
    console.error(USAGE);
    return false;
  }

  const platform = await loadPlatform(getCachePath());
  console.log(`Bond ${platform.data.notoBondAddress}, cash ${platform.data.notoCashAddress}`);
  console.log(`Outright: ${values.seller} sells ${values.units} bond to ${values.buyer} @ ${values.price}`);

  try {
    const trade = await executeOutright(platform, {
      seller: values.seller,
      buyer: values.buyer,
      units: values.units,
      price: values.price,
      tradeId: values["trade-id"],
    });
    appendTrade(platform.dataDir, trade);
    console.log(JSON.stringify(trade, null, 2));
    if (trade.status === "ROLLED_BACK") {
      console.error(`ROLLED_BACK after ${trade.failedStep}: ${trade.error}. All locks released, balances restored.`);
      return false;
    }
    if (trade.status === "FAILED") {
      console.error(`FAILED at ${trade.failedStep}: ${trade.error}`);
      if (trade.rollbackError) console.error(`Rollback failed: ${trade.rollbackError}`);
      console.error("Open locks need an operator; see openLocks in the trade record.");
      return false;
    }
    console.log(`SETTLED: ${trade.units} bond for ${trade.consideration} cash (trade ${trade.tradeId})`);
    return true;
  } catch (err) {
    if (err instanceof TradeRejected) {
      console.error(`REJECTED (nothing submitted on-chain): ${err.message}`);
      return false;
    }
    throw err;
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error("Exiting with uncaught error");
    console.error(err);
    process.exit(1);
  });
