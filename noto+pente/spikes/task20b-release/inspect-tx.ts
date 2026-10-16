import RawPaladinClient from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "paladin-example-common";

async function main() {
  const rawNode1 = new RawPaladinClient(nodeConnections[0].clientOptions);
  const txId = "c8cb3238-6e64-47b9-84d0-8ff1ea8f357e";
  const receipt = await rawNode1.ptx.getTransactionReceiptFull(txId);
  console.log(JSON.stringify(receipt, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
