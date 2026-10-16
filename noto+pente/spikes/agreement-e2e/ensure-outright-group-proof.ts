/*
 * Task #8 / 0.3.1 mandatory live proof for `ensureOutrightGroup` + `sendGroupMessage`
 * (lead-required, 2026-10-05).
 *
 * 1. BI (node1) calls ensureOutrightGroup(investorA, investorB) -> groupId (creates fresh).
 * 2. investorA's OWN client (node2) calls ensureOutrightGroup(..., knownGroupId=groupId) and
 *    must get back the IDENTICAL groupId -- proves RESUME, not a new (randomly-salted, per
 *    manager.go:253) group, since a real re-create would always produce a different id.
 * 3. investorA (node2) sends a group message (topic "outright-group") via the REAL
 *    `sendGroupMessage` client method (0.3.1: no longer a stub) -- investorB (node3),
 *    listening on the SAME groupId via the real onGroupMessage, must receive it. Cross-member
 *    delivery is independent proof both clients are really in the same group.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node ensure-outright-group-proof.ts
 */
import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient } from "../../common/paladin-client/src/index";
import type { PaladinClient as PaladinClientWrapper } from "../../common/paladin-client/src/types";

const logger = console;
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<boolean> {
  const runId = Date.now();
  const biName = `biG${runId}`;
  const investorAName = `invAG${runId}`;
  const investorBName = `invBG${runId}`;

  // wsUrl's default derivation (http->ws, SAME port) doesn't match this cluster's
  // port-forward convention (WS is a SEPARATE port, HTTP+1 -- see
  // Paladin/scripts/port-forward-start.sh's own comment) -- must be passed explicitly whenever
  // a WS-based listener (onGroupMessage, onBlockchainEvent, onOwnReceipt) is used. Omitting it
  // hangs on a silent [405] WS-upgrade-rejected reconnect loop against the HTTP-only port
  // (found live writing this proof).
  const wsUrlFor = (httpUrl: string) => {
    const u = new URL(httpUrl);
    u.protocol = "ws:";
    u.port = String(Number(u.port) + 1);
    return u.toString();
  };

  const biClient: PaladinClientWrapper = await connectPaladinClient({
    nodeUrl: nodeConnections[0].clientOptions.url!,
    wsUrl: wsUrlFor(nodeConnections[0].clientOptions.url!),
    nodeId: nodeConnections[0].id,
    identity: biName,
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

  logger.log("=== Step 1: BI creates the group ===");
  const { groupId } = await biClient.ensureOutrightGroup(investorALookup, investorBLookup);
  logger.log(`groupId=${groupId}`);
  check("groupId looks real", !!groupId && groupId.length > 0, groupId);

  logger.log("=== Step 2: investorA resumes with knownGroupId ===");
  const resumed = await investorAClient.ensureOutrightGroup(investorALookup, investorBLookup, groupId);
  check("investorA's ensureOutrightGroup(knownGroupId) returns the IDENTICAL groupId (resumed, not a new group)", resumed.groupId === groupId, `original=${groupId} resumed=${resumed.groupId}`);

  logger.log("=== Step 3: cross-member message delivery on the RESUMED group ===");
  const received: unknown[] = [];
  await investorBClient.onGroupMessage(`outright-group-listener-${runId}`, groupId, async (msg) => {
    received.push(msg);
  });
  await sleep(1000);

  await investorAClient.sendGroupMessage(groupId, "outright-group", { hello: "from investorA", runId });

  const start = Date.now();
  while (received.length === 0 && Date.now() - start < 20000) {
    await sleep(1000);
  }
  check("investorB receives investorA's group message on the resumed group", received.length > 0, JSON.stringify(received));

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
