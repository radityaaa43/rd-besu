import RawPaladinClient, { PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "paladin-example-common";

async function main() {
  const rawNode1 = new RawPaladinClient(nodeConnections[0].clientOptions);
  const groupId = "0xe57210e05a7a24b925d411c541ab8be0aa0559abb96146eccf2db7a86ff196e9";
  const group = await rawNode1.pgroup.getGroupById("pente", groupId);
  console.log(JSON.stringify(group, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
