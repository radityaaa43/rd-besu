import * as assert from "assert";
import { Atom, AtomFactory } from "../helpers/atom";
import factoryJson from "../abis/RestrictedAtomFactory.json";

// Fake PaladinClient: records what the helper sends, answers with a canned AtomDeployed event.
const sent: any[] = [];
const fake: any = {
  ptx: { sendTransaction: async (tx: any) => (sent.push(tx), "tx-" + sent.length) },
  pollForReceipt: async () => ({ transactionHash: "0xabc" }),
  bidx: { decodeTransactionEvents: async () => [{ soliditySignature: "event AtomDeployed(address addr)", data: { addr: "0xA70" } }] },
};
const verifier: any = { lookup: "custodian@node1" };

(async () => {
  const create = factoryJson.abi.find((f: any) => f.name === "create")!;
  assert.deepStrictEqual(create.inputs.map((i: any) => i.name), ["operations", "cancelOperations", "parties", "executor"]);

  const ops = [{ contractAddress: "0x1", callData: "0x01" }];
  const cancels = [{ contractAddress: "0x1", lockId: "0x" + "11".repeat(32), callData: "0x02" }];
  const atom = await new AtomFactory(fake, "0xF").create(verifier, ops, cancels, ["0xB", "0xS"], "0xC");
  assert.strictEqual(atom?.address, "0xA70");
  assert.strictEqual(sent[0].function, "create");
  assert.deepStrictEqual(sent[0].data, { operations: ops, cancelOperations: cancels, parties: ["0xB", "0xS"], executor: "0xC" });

  await new Atom(fake, "0xA70").cancel(verifier);
  assert.strictEqual(sent[1].function, "cancel");
  assert.strictEqual(sent[1].to, "0xA70");
  console.log("restricted atom helper checks passed");
})();
