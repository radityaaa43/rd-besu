// Minimal stand-in for Paladin's examples/common (paladin-example-common): node connections
// from ../config.json, poll timeouts, and the checkDeploy/checkReceipt helpers.
import * as fs from "fs";
import * as path from "path";
import { ITransactionReceipt, PaladinConfig } from "@lfdecentralizedtrust/paladin-sdk";

export const DEFAULT_POLL_TIMEOUT = 30000;
export const LONG_POLL_TIMEOUT = 120000;

export interface NodeConnection {
  name: string;
  id: string;
  clientOptions: PaladinConfig;
}

export const nodeConnections: NodeConnection[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"),
).map((n: { name: string; id: string; client: { url: string } }) => ({
  name: n.name,
  id: n.id,
  clientOptions: { url: n.client.url },
}));

export function checkDeploy(contract: { address: string } | undefined): contract is { address: string } {
  if (contract === undefined) {
    console.error("Failed!");
    return false;
  }
  console.log(`Success! address: ${contract.address}`);
  return true;
}

export function checkReceipt(receipt: ITransactionReceipt | undefined): receipt is ITransactionReceipt {
  if (receipt === undefined) {
    console.error("Failed!");
    return false;
  } else if (receipt.failureMessage !== undefined) {
    console.error(`Failed: ${receipt.failureMessage}`);
    return false;
  }
  console.log("Success!");
  return true;
}
