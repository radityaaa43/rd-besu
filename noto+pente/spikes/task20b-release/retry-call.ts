import RawPaladinClient, { PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "paladin-example-common";

async function main() {
  const rawNode1 = new RawPaladinClient(nodeConnections[0].clientOptions);
  const groupId = "0xe57210e05a7a24b925d411c541ab8be0aa0559abb96146eccf2db7a86ff196e9";
  const group = await new PenteFactory(rawNode1, "pente").resumePrivacyGroup({ id: groupId });
  if (!group) { console.log("resumePrivacyGroup returned undefined"); return; }
  console.log("resumed group address:", group.address);
  try {
    const result = await group.call({
      to: "0x15db0b173cd8804c7b37d7a3aaa306b6e4409978",
      methodAbi: { type: "function", name: "investorList", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
      from: "bondCustodian@node1",
      data: [],
    });
    console.log("result:", JSON.stringify(result));
  } catch (e) {
    console.error("call failed:", (e as Error).message);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
