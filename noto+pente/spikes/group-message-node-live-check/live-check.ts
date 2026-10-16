/*
 * Task #14 live check (1 real group message, fresh ephemeral group -- does NOT touch
 * bank1/bank2's real-mode run or any existing group/data):
 *
 * GroupMessage.sender never existed on the wire (pldapi.PrivacyGroupMessage has no
 * identity-level sender field -- only `node`, overwritten by the RECEIVING node's transport
 * from the authenticated mTLS peer). Proof: investorA (node2) sends a real group message,
 * investorB (node3) receives it via the fixed onGroupMessage/toGroupMessage mapping, and the
 * received message's `node` is "node2" (the REAL sending node, authenticated by Paladin, not
 * supplied by the payload) with no `sender` field at all.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node live-check.ts
 */
import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient } from "../../common/paladin-client/src/index";
import type { PaladinClient as PaladinClientWrapper } from "../../common/paladin-client/src/types";

const logger = console;
let failures = 0;
function check(label: string, pass: boolean, detail?: unknown) {
  if (pass) {
    console.log(`OK   - ${label}`);
  } else {
    failures++;
    console.error(`FAIL - ${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
const wsUrlFor = (httpUrl: string) => {
  const u = new URL(httpUrl);
  u.protocol = "ws:";
  u.port = String(Number(u.port) + 1);
  return u.toString();
};

async function main(): Promise<boolean> {
  const runId = Date.now();
  const biName = `biN${runId}`;
  const investorAName = `invAN${runId}`;
  const investorBName = `invBN${runId}`;

  // ensureOutrightGroup signs the group-create as the configured bondCustodian (a required
  // group member in production too) -- must be on the SAME node as this client (node1).
  const biClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    wsUrl: wsUrlFor(nodeConnections[0].clientOptions.url!),
    nodeId: nodeConnections[0].id,
    identity: biName,
    identities: { bondCustodian: `bondCustodian@${nodeConnections[0].id}` },
  });
  const investorAClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[1].clientOptions.url!,
    wsUrl: wsUrlFor(nodeConnections[1].clientOptions.url!),
    nodeId: nodeConnections[1].id,
    identity: investorAName,
  });
  const investorBClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[2].clientOptions.url!,
    wsUrl: wsUrlFor(nodeConnections[2].clientOptions.url!),
    nodeId: nodeConnections[2].id,
    identity: investorBName,
  });

  const investorALookup = `${investorAName}@${nodeConnections[1].id}`;
  const investorBLookup = `${investorBName}@${nodeConnections[2].id}`;

  logger.log("=== Fresh ephemeral group (does not touch any real bank group) ===");
  const { groupId } = await biClient.ensureOutrightGroup(investorALookup, investorBLookup);
  logger.log(`groupId=${groupId}`);

  logger.log("=== investorB listens, investorA sends ===");
  const received: Array<Record<string, unknown>> = [];
  await investorBClient.onGroupMessage(`node-field-check-${runId}`, groupId, async (msg) => {
    received.push(msg as unknown as Record<string, unknown>);
  });
  await sleep(1000);

  await investorAClient.sendGroupMessage(groupId, "node-field-check", { hello: "from investorA", runId });

  const start = Date.now();
  while (received.length === 0 && Date.now() - start < 20000) {
    await sleep(1000);
  }

  check("investorB received the message", received.length > 0, received);
  if (received.length > 0) {
    const msg = received[0];
    check("message.node === the REAL sending node (node2), authenticated by Paladin's transport", msg.node === nodeConnections[1].id, msg);
    check("message.sender does NOT exist on the real payload", !("sender" in msg), msg);
    check("message.groupId is the real groupId (mapped from raw `group`)", msg.groupId === groupId, msg);
  }

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
