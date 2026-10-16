/*
 * Live smoke test for paladin-client phase 1, on a scratch series -- not the current bond
 * series, nothing shared with it. Connects to node2 only (as task #4 part C specifies), proving
 * this client really is single-node/single-identity, not the multi-node pattern
 * bond/src/lib/platform.ts uses.
 *
 * Checks, in order:
 * 1. connect() to node2.
 * 2. balances(tokenAddress).available/locked before and after a lock -- proves the
 *    available/locked split (platform-extensibility rule 5) is real, not just typed.
 * 3. onOwnReceipt fires for the lock transaction this same identity just submitted.
 * 4. onBlockchainEvent fires for a plain public AtomDeployed(address addr) event.
 *
 * Run: NODE_PATH=../../bond/node_modules:./node_modules ./node_modules/.bin/ts-node scripts/smoke.ts
 * (needs the 4-node port-forward running: Paladin/scripts/port-forward-start.sh)
 */
import PaladinClientSdk, { NotoFactory, PenteFactory, TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import atomFactoryJson from "../../../bond/src/abis/AtomFactory.json";
import { newERC20Tracker } from "../../../bond/src/helpers/erc20tracker";
import { connect } from "../src/index";

const NODE2_URL = "http://127.0.0.1:31648";
const NODE1_URL = "http://127.0.0.1:31548"; // only to deploy a scratch token/notary, not used as "the" client under test
const DEFAULT_POLL_TIMEOUT = 30000; // local constant -- avoids a dependency on paladin-example-common for one number, this script is a dev tool, not shipped

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};

async function main(): Promise<boolean> {
  const runId = Date.now();

  // --- Set up a scratch hooks-mode cash token + fund the node2 identity, using the SDK
  // directly (not paladin-client -- that's phase 2, lockToken/mintToken aren't implemented).
  // This setup is scaffolding for the smoke test, not part of what's under test.
  const node1 = new PaladinClientSdk({ url: NODE1_URL });
  const node2Sdk = new PaladinClientSdk({ url: NODE2_URL });
  const [notary] = node1.getVerifiers(`smokeNotary${runId}@node1`);
  const [subject] = node2Sdk.getVerifiers(`smokeSubject${runId}@node2`);

  const penteFactory = new PenteFactory(node1, "pente");
  const group = await penteFactory.newPrivacyGroup({ members: [notary], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!group) return fail("privacy group deploy failed");
  const tracker = await newERC20Tracker(group, notary, { name: "SMOKE", symbol: "SMK" });
  if (!tracker) return fail("tracker deploy failed");
  const token = await new NotoFactory(node1, "noto")
    .newNoto(notary, {
      name: "SMOKE",
      symbol: "SMK",
      notary,
      notaryMode: "hooks",
      options: { hooks: { privateGroup: group, publicAddress: group.address, privateAddress: tracker.address } },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!token) return fail("token deploy failed");
  console.log(`scratch token=${token.address}`);

  let receipt = await token.mint(notary, { to: subject, amount: 1000, data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!receipt?.success) return fail("mint failed");

  // --- Under test: paladin-client, connected to node2 only ---
  // NOTE: the shared Paladin/scripts/port-forward-start.sh only forwards the HTTP RPC port
  // (:8548) -- WS lives on a separate port (:8549, confirmed via `kubectl get svc paladin-node2
  // -o jsonpath=.spec.ports`: rpc-http=8548, rpc-ws=8549, distinct target ports). For this smoke
  // test specifically, run an EXTRA ad-hoc port-forward for node2's WS port rather than editing
  // the shared script (which other sessions/tasks also rely on):
  //   kubectl port-forward -n paladin svc/paladin-node2 41648:8549
  // In the real deployed topology (backend-bankN -> paladin-nodeN inside the cluster) this is a
  // non-issue -- the ClusterIP service already exposes both ports natively, no port-forward at
  // all. Flagged to the lead as a dev-tooling gap worth fixing in the shared script, not fixed
  // here since it's shared infra outside this task's scope.
  const client = await connect({ nodeUrl: NODE2_URL, wsUrl: "ws://127.0.0.1:41648", nodeId: "node2", identity: `smokeSubject${runId}` });

  const before = await client.balances(token.address);
  check("balances before lock", before.available === "1000" && before.locked === "0", JSON.stringify(before));

  // --- onOwnReceipt: node2's own identity submits the lock, so this node originated it ---
  // A brand-new listener name has no checkpoint, so Paladin replays this node's ENTIRE
  // historical receipt log first (node2 has a long history from earlier live sessions this
  // session) -- confirmed live: the first delivery was an old receipt, not the lock below.
  // This is correct Paladin behavior (a fresh durable listener resuming from genesis is the
  // right default for a backend that's never run before), not a client bug -- so the smoke
  // test accumulates every id seen and waits for the specific one, instead of assuming the
  // first delivery is the one just submitted.
  // node2 has 12,000+ historical receipts from earlier live sessions -- a listener with no
  // sequence floor would take over a minute just to replay them (confirmed live). Find the
  // current max sequence directly via node2Sdk (paladin-client doesn't expose raw receipt
  // queries -- out of scope for phase 1) and pre-create the listener with that floor myself.
  // client.onOwnReceipt below will then try to create the SAME name and hit "already exists"
  // (PD012237) -- which client.ts now treats as success (idempotent resume, the fix this smoke
  // run surfaced), so it reuses this filtered listener rather than erroring or replacing it.
  // This simultaneously proves the idempotent-create fix works end-to-end.
  const receiptListenerName = `smoke-receipts-${runId}`;
  const latest = await node2Sdk.ptx.queryTransactionReceipts({ sort: ["-sequence"], limit: 1 });
  const sequenceFloor = latest[0]?.sequence ?? 0;
  console.log(`current max receipt sequence on node2: ${sequenceFloor}`);
  await node2Sdk.ptx.createReceiptListener({ name: receiptListenerName, filters: { sequenceAbove: sequenceFloor }, options: { domainReceipts: true } });

  const receiptIdsSeen = new Set<string>();
  const receiptSuccessById = new Map<string, boolean>();
  const receiptHandle = await client.onOwnReceipt(receiptListenerName, async (r) => {
    receiptIdsSeen.add(r.id);
    receiptSuccessById.set(r.id, r.success);
  });

  const lockReceipt = await token.using(node2Sdk).lock(subject, { amount: "100", data: "0x" }).waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
  if (!lockReceipt?.success) return fail("lock failed");
  console.log(`lockReceipt.id=${lockReceipt.id}, waiting for it to surface...`);

  const receiptWaitUntil = Date.now() + 30000;
  while (!receiptIdsSeen.has(lockReceipt.id) && Date.now() < receiptWaitUntil) {
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`saw ${receiptIdsSeen.size} receipt(s) total before/including the lock`);

  // --- onBlockchainEvent: a plain public AtomDeployed(address addr) event, decoupled from Noto ---
  let eventSeen: { address: string; soliditySignature: string } | undefined;
  const eventListenerName = `smoke-events-${runId}`;
  let atomFactoryAddress = "";
  {
    const txId = await node1.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: atomFactoryJson.abi,
      bytecode: atomFactoryJson.bytecode,
      function: "",
      from: notary.lookup,
      data: {},
    });
    const r = await node1.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT);
    if (!r?.contractAddress) return fail("atom factory deploy failed");
    atomFactoryAddress = r.contractAddress;
  }
  const eventHandle = await client.onBlockchainEvent(eventListenerName, atomFactoryAddress, "AtomDeployed(address addr)", async (e) => {
    eventSeen = { address: e.address, soliditySignature: e.soliditySignature };
  });

  {
    const txId = await node2Sdk.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: atomFactoryJson.abi,
      function: "create",
      from: subject.lookup,
      to: atomFactoryAddress,
      data: { operations: [] },
    });
    const r = await node2Sdk.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT);
    if (!r?.success) return fail("AtomFactory.create failed");
  }

  // Give both websocket listeners a moment to receive and ack their batch.
  await new Promise((r) => setTimeout(r, 3000));

  check(
    "onOwnReceipt fired for node2's own lock tx",
    receiptIdsSeen.has(lockReceipt.id) && receiptSuccessById.get(lockReceipt.id) === true,
    `seen=${receiptIdsSeen.has(lockReceipt.id)} success=${receiptSuccessById.get(lockReceipt.id)}`
  );
  check("onBlockchainEvent fired for AtomDeployed", eventSeen?.soliditySignature.startsWith("event AtomDeployed") === true, JSON.stringify(eventSeen));

  const after = await client.balances(token.address);
  check("balances after lock: available decreased by 100", after.available === "900", JSON.stringify(after));
  check("balances after lock: locked increased by 100", after.locked === "100", JSON.stringify(after));

  await receiptHandle.stop();
  await eventHandle.stop();
  await client.disconnect();

  console.log(failures === 0 ? "\nSUCCESS: paladin-client phase 1 smoke test passed" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

function fail(msg: string): false {
  console.error(msg);
  return false;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
