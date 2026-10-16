import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, loadClientConfigFile } from "../../common/paladin-client/src/index";

async function main() {
  const bank2Cfg = loadClientConfigFile("/home/ecs-user/alibaba-kube/Paladin/bootstrap/out/contract-data-bank2.json", { nodeUrl: nodeConnections[1].clientOptions.url! });
  const investor2Client = await connectPaladinClient(bank2Cfg);
  const balance = await investor2Client.balances("0x98143f4bff2281d6b20fa4987daf9f31d22c9c77");
  console.log(JSON.stringify(balance));
}
main().catch((e) => { console.error(e); process.exit(1); });
