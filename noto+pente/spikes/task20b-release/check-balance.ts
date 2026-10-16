import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, loadClientConfigFile } from "../../common/paladin-client/src/index";

async function main() {
  const bank1Cfg = loadClientConfigFile("/home/ecs-user/alibaba-kube/Paladin/bootstrap/out/contract-data-bank1.json", { nodeUrl: nodeConnections[0].clientOptions.url! });
  const custodianClient = await connectPaladinClient(bank1Cfg);
  const balance = await custodianClient.balances("0xd56fe21a3fe25583a29b878ef4ccb0a51cc5f48a");
  console.log(JSON.stringify(balance));
}
main().catch((e) => { console.error(e); process.exit(1); });
