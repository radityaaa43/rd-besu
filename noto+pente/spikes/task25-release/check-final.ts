import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, loadClientConfigFile } from "../../common/paladin-client/src/index";
const OUT_DIR = "/home/ecs-user/alibaba-kube/Paladin/bootstrap/out";
const BOND_TOKEN = "0x2b4cbd5a6bc005a1fc695519dd983c3af0c4d20b";
async function main() {
  const node1 = nodeConnections[0];
  const cfg = loadClientConfigFile(`${OUT_DIR}/contract-data-bank1.json`, { nodeUrl: node1.clientOptions.url! });
  const client = await connectPaladinClient(cfg);
  console.log(JSON.stringify(await client.balances(BOND_TOKEN)));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
