/*
 * Option A, step 1: Pente privacy-group messaging spike (docs/plans/2026-10-16-option-a-bi-reporting.md).
 * Proves the channel a bank would use to report each Zeto tx to BI (bi@node4), using only
 * official v1.0.0 APIs: pgroup_createGroup (via PenteFactory), pgroup_sendMessage,
 * pgroup_queryMessages, pgroup_getMessageById.
 *   M1 create group {investor2@node2, bi@node4}; read back members + contractAddress
 *   M2 investor2 sends a message; BI's node4 receives it
 *   M3 investor3@node3 sees neither the group nor the message
 *   M4 node4 down: investor2 sends 3 messages (calls must succeed); after node4 is Ready, all 3
 *      arrive (order recorded)
 *   M5 createGroup while node4 is down: behaviour recorded (blocking or failing is acceptable)
 * The node4 restart is done by the lead, never by this script: after M3 it prints
 * "ready for node4 restart", waits for node4 to stop answering, runs M4/M5, then waits for
 * node4 to answer again.
 *
 * SAFE BY DEFAULT: dry-run unless --execute. Run from this directory (port-forwards up).
 *   npx ts-node spike-bi-messaging.ts [--execute] [--no-restart]   (--no-restart: M1-M3 only)
 */
import PaladinClient, { PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, nodeConnections } from "./src/common";

const logger = console;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOMAIN = "pente";
const TOPIC = "spike-bi-msg";
const RESTART_WAIT = 30 * 60 * 1000; // lead deletes the pod by hand

const [node1, node2, node3, node4] = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
void node1;
const investor2 = node2.getVerifiers("investor2@node2")[0];
const bi = node4.getVerifiers("bi@node4")[0];

const results: { name: string; pass: boolean }[] = [];
function record(name: string, pass: boolean, detail = "") {
  results.push({ name, pass });
  logger.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail.slice(0, 300)}` : ""}`);
}
const note = (name: string, detail: string) => logger.log(`NOTE ${name} -- ${detail}`);
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

// A node "answers" when transport_nodeName returns; any error (pod down or forward gone) = down.
async function answers(c: PaladinClient) {
  try {
    await Promise.race([c.transport.nodeName(), sleep(5000).then(() => Promise.reject(new Error("timeout")))]);
    return true;
  } catch {
    return false;
  }
}
async function waitFor(what: string, cond: () => Promise<boolean>, timeout: number) {
  for (const start = Date.now(); Date.now() - start < timeout; await sleep(2000)) if (await cond()) return true;
  logger.log(`   gave up waiting for ${what} after ${timeout / 1000}s`);
  return false;
}

const byGroup = (group: string) => ({ limit: 100, sort: ["localSequence"], eq: [{ field: "group", value: group }] }) as any;
const send = (group: string, data: unknown) => node2.pgroup.sendMessage({ domain: DOMAIN, group, topic: TOPIC, data });
// Messages node4 holds for the group, in node4's own receive order.
const biMessages = async (group: string): Promise<any[]> => (await node4.pgroup.queryMessages(byGroup(group))) ?? [];

async function newGroup(name: string, waitMs: number) {
  return new PenteFactory(node2, DOMAIN)
    .newPrivacyGroup({ name, members: [investor2, bi], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(waitMs);
}

async function main() {
  const execute = process.argv.includes("--execute");
  logger.log("=== Option A step 1: Pente privacy-group messaging spike ===");
  logger.log("Creates group {investor2@node2, bi@node4}, runs M1 M2 M3, pauses for the lead's node4 restart, then M4 M5.");
  if (!execute) {
    logger.log("\nDRY RUN -- nothing sent. Pass --execute to run.");
    return;
  }
  const stamp = Date.now();

  // M1
  const group = await newGroup(`bi-spike-investor2-${stamp}`, LONG_POLL_TIMEOUT);
  if (!group) throw new Error("M1 group deploy failed");
  const g = group.group;
  // node4 learns the contract address from its own indexer, a few seconds after node2's receipt.
  let read: Awaited<ReturnType<typeof node4.pgroup.getGroupById>> | undefined;
  await waitFor("contractAddress on node4", async () => !!(read = await node4.pgroup.getGroupById(DOMAIN, g.id))?.contractAddress, DEFAULT_POLL_TIMEOUT);
  const members = [...(read?.members ?? [])].sort().join(",");
  const want = ["bi@node4", "investor2@node2"].join(",");
  record("M1 group created; BI's node4 reads back members + contractAddress",
    members === want && read?.contractAddress === group.address,
    `id=${g.id} members=${members} contract=${read?.contractAddress}`);

  // M2
  const m2 = { kind: "probe", step: "M2", stamp };
  const m2Id = await send(g.id, m2);
  let got: any;
  await waitFor("M2 on node4", async () => !!(got = await node4.pgroup.getMessageById(m2Id)), DEFAULT_POLL_TIMEOUT);
  record("M2 BI's node4 receives investor2's message", JSON.stringify(got?.data) === JSON.stringify(m2) && got?.node === "node2",
    got ? `id=${m2Id} node=${got.node} sent=${got.sent} received=${got.received}` : `id=${m2Id} not on node4`);

  // M3
  const [g3, msgs3, m3] = await Promise.all([
    node3.pgroup.getGroupById(DOMAIN, g.id).catch(() => undefined),
    node3.pgroup.queryMessages(byGroup(g.id)).catch(() => []),
    node3.pgroup.getMessageById(m2Id).catch(() => undefined),
  ]);
  record("M3 investor3's node3 sees neither group nor message", !g3 && (msgs3 ?? []).length === 0 && !m3,
    `group=${g3 ? "VISIBLE" : "none"} messages=${(msgs3 ?? []).length} byId=${m3 ? "VISIBLE" : "none"}`);

  if (process.argv.includes("--no-restart")) return summary();

  // M4 / M5: lead restarts node4.
  logger.log("\n>>> ready for node4 restart <<<  (waiting for node4 to stop answering)");
  if (!(await waitFor("node4 down", async () => !(await answers(node4)), RESTART_WAIT))) throw new Error("node4 never went down");
  const downAt = Date.now();
  logger.log(`   node4 down at ${new Date(downAt).toISOString()}`);

  const sentIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    try {
      sentIds.push(await send(g.id, { kind: "probe", step: "M4", seq: i, stamp }));
    } catch (e) {
      logger.log(`   M4 send ${i} threw: ${errText(e)}`);
    }
  }
  const stillDown = !(await answers(node4));
  record("M4a investor2's 3 sends succeed while node4 is down", sentIds.length === 3 && stillDown,
    `${sentIds.length}/3 accepted, node4 still down=${stillDown}, ids=${sentIds.join(",")}`);

  // M5 runs in the background: it may block until node4 is back.
  const m5Start = Date.now();
  const m5 = new PenteFactory(node2, DOMAIN)
    .newPrivacyGroup({ name: `bi-spike-offline-${stamp}`, members: [investor2, bi], evmVersion: "shanghai", externalCallsEnabled: true })
    .waitForDeploy(RESTART_WAIT)
    .then((x) => ({ ok: !!x, at: Date.now(), detail: x ? `contract=${x.address}` : "no contract address" }))
    .catch((e) => ({ ok: false, at: Date.now(), detail: errText(e) }));
  const early = await Promise.race([m5, sleep(60000).then(() => undefined)]);
  note("M5 createGroup while node4 down (first 60s)",
    early ? `${early.ok ? "succeeded" : "failed"} after ${Math.round((early.at - m5Start) / 1000)}s: ${early.detail}` : "still pending after 60s (blocks)");

  logger.log("   waiting for node4 to answer again (lead restores pod + forward)");
  if (!(await waitFor("node4 up", () => answers(node4), RESTART_WAIT))) throw new Error("node4 never came back");
  const upAt = Date.now();
  logger.log(`   node4 answering at ${new Date(upAt).toISOString()} (down ${Math.round((upAt - downAt) / 1000)}s)`);

  let seen: any[] = [];
  await waitFor("M4 messages on node4", async () => {
    seen = (await biMessages(g.id)).filter((m) => sentIds.includes(m.id));
    return seen.length === sentIds.length;
  }, LONG_POLL_TIMEOUT);
  const order = seen.map((m) => sentIds.indexOf(m.id) + 1).join(",");
  record("M4b all 3 messages reach node4 after restart", sentIds.length === 3 && seen.length === 3,
    `${seen.length}/3 arrived ${Math.round((Date.now() - upAt) / 1000)}s after node4 up; node4 order=${order || "-"} (send order 1,2,3)`);
  note("M4 ordering", order === "1,2,3" ? "node4 received in send order" : `node4 order ${order || "-"} differs from send order`);

  const final = await Promise.race([m5, sleep(LONG_POLL_TIMEOUT).then(() => undefined)]);
  note("M5 createGroup outcome",
    final ? `${final.ok ? "succeeded" : "failed"} ${Math.round((final.at - m5Start) / 1000)}s after the call (node4 was up after ${Math.round((upAt - m5Start) / 1000)}s): ${final.detail}`
      : `still pending ${Math.round((Date.now() - m5Start) / 1000)}s after the call, 120s after node4 came back`);

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.pass);
  logger.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((r) => logger.log(`  FAIL ${r.name}`));
  logger.log(`BI messaging spike: ${failed.length ? "FAIL" : "PASS"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  logger.error("BI messaging spike: FAIL", err);
  process.exit(1);
});
