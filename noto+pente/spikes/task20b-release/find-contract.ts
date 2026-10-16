import RawPaladinClient, { PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { nodeConnections } from "paladin-example-common";

async function main() {
  const rawNode1 = new RawPaladinClient(nodeConnections[0].clientOptions);
  const groupId = "0xe57210e05a7a24b925d411c541ab8be0aa0559abb96146eccf2db7a86ff196e9";
  const group = await new PenteFactory(rawNode1, "pente").resumePrivacyGroup({ id: groupId });
  if (!group) { console.log("no group"); return; }
  const candidates = ["0x4b46c99b002faec5d5f4a29f9fc54caab12c1928", "0x4e0db5b819ba4516e25747a4438e0cf0cf7a7931", "0x900bb5b2043366f2bb3ee1e7c79a0eef793ae284"];
  for (const addr of candidates) {
    try {
      const result = await group.call({
        to: addr,
        methodAbi: { type: "function", name: "investorList", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
        from: "bondCustodian@node1",
        data: [],
      });
      console.log(`${addr}: investorList() -> ${JSON.stringify(result)}`);
    } catch (e) {
      console.log(`${addr}: FAILED -- ${(e as Error).message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
