import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, loadClientConfigFile } from "../../common/paladin-client/src/index";

const OUT_DIR = "/home/ecs-user/alibaba-kube/Paladin/bootstrap/out";
const GROUP_ID = "0xa4f83a48866fcf0b544551de779cfda8c11ae7e0cd3688a8809b597043e3b99a";
const TRADE_ID = "0x2366a74684315f23583d8c145a22349e6b66825b:bank1:redemption-b4c686d3-42e1-46d9-9523-54e92e030f13-investor2@node2-r1";
const CANDIDATES = ["0x1d42fff09379521288b96f395210a1bf21c1cdf7"];

async function main() {
  const node1 = nodeConnections[0];
  const bank1Cfg = loadClientConfigFile(`${OUT_DIR}/contract-data-bank1.json`, { nodeUrl: node1.clientOptions.url! });
  const client = await connectPaladinClient(bank1Cfg);

  for (const addr of CANDIDATES) {
    try {
      await client.resumeAgreement(GROUP_ID, addr);
      const trade = await client.getAgreement(GROUP_ID, addr, TRADE_ID);
      console.log(`=== MATCH at ${addr} ===`);
      console.log(JSON.stringify(trade, null, 2));
    } catch (e) {
      console.log(`FAIL ${addr}: ${(e as Error).message}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
