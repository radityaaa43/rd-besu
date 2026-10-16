/*
 * Live resume test for paladin-client phase 1 (task #4b item 2, closing the [unverified] gap
 * from task #4's report): proves a durable listener reconnecting with the SAME listenerName
 * resumes gap-free -- no replay of what it already saw, no skip of what happened while
 * disconnected.
 *
 * Uses onBlockchainEvent rather than onOwnReceipt: simpler to set up deterministically (no
 * Noto/Pente privacy group needed, just repeated AtomFactory.create() calls, each emitting a
 * distinguishable AtomDeployed(address addr) with a different `addr`), and it shares the exact
 * same listener/ack/nack machinery (createListenerIdempotent, dispatchBatch, openWsListener) as
 * onOwnReceipt -- proving resume here is evidence for both, not a separate code path.
 *
 * Sequence:
 * 1. listener A (fresh, never-seen name) connects, receives event 1.
 * 2. listener A disconnects (client.disconnect()) -- server-side listener + checkpoint persist.
 * 3. while NOTHING is connected, submit events 2 and 3.
 * 4. listener B reconnects with the SAME listenerName, same client config.
 * 5. assert listener B receives EXACTLY {event2, event3} -- not event1 again, nothing missing.
 *
 * Run: NODE_PATH=../../bond/node_modules:./node_modules ./node_modules/.bin/ts-node scripts/resume-test.ts
 * (needs the 4-node port-forward running, INCLUDING the :8549 WS ports added in task #4b:
 * Paladin/scripts/port-forward-start.sh)
 */
import PaladinClientSdk, { TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import atomFactoryJson from "../../../bond/src/abis/AtomFactory.json";
import { connect } from "../src/index";

const NODE2_URL = "http://127.0.0.1:31648";
const NODE2_WS_URL = "ws://127.0.0.1:31649";
const DEFAULT_POLL_TIMEOUT = 30000;

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} - ${label}: ${detail}`);
  if (!ok) failures++;
};

async function deployAndCreate(sdk: PaladinClientSdk, identityLookup: string, existingFactoryAddress: string | undefined) {
  let factoryAddress: string;
  if (existingFactoryAddress) {
    factoryAddress = existingFactoryAddress;
  } else {
    const txId = await sdk.ptx.sendTransaction({ type: TransactionType.PUBLIC, abi: atomFactoryJson.abi, bytecode: atomFactoryJson.bytecode, function: "", from: identityLookup, data: {} });
    const r = await sdk.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT);
    if (!r?.contractAddress) throw new Error("factory deploy failed");
    factoryAddress = r.contractAddress;
  }
  const txId = await sdk.ptx.sendTransaction({ type: TransactionType.PUBLIC, abi: atomFactoryJson.abi, function: "create", from: identityLookup, to: factoryAddress, data: { operations: [] } });
  const r = await sdk.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT);
  if (!r?.success) throw new Error("create() failed");
  const events = await sdk.bidx.decodeTransactionEvents(r.transactionHash, atomFactoryJson.abi, "");
  const deployed = events.find((e) => e.soliditySignature.startsWith("event AtomDeployed"));
  if (!deployed) throw new Error("AtomDeployed event not found in create() receipt");
  const deployedAddress = (deployed.data as { addr: string }).addr;
  return { factoryAddress, deployedAddress };
}

async function main(): Promise<boolean> {
  const runId = Date.now();
  const sdk = new PaladinClientSdk({ url: NODE2_URL });
  const [identity] = sdk.getVerifiers(`resumeTest${runId}@node2`);

  const first = await deployAndCreate(sdk, identity.lookup, undefined);
  const factoryAddress = first.factoryAddress;
  console.log(`factory=${factoryAddress}, event1 addr=${first.deployedAddress}`);

  const listenerName = `resume-test-${runId}`;
  const seenByA: string[] = [];
  const clientA = await connect({ nodeUrl: NODE2_URL, wsUrl: NODE2_WS_URL, nodeId: "node2", identity: `resumeTest${runId}` });
  const handleA = await clientA.onBlockchainEvent(listenerName, factoryAddress, "AtomDeployed(address addr)", async (e) => {
    seenByA.push((e.data as { addr: string }).addr);
  });

  // event 1 already happened (it's what `first` produced); confirm A sees it.
  const waitFor = async (seen: () => string[], expectedCount: number, timeoutMs: number) => {
    const until = Date.now() + timeoutMs;
    while (seen().length < expectedCount && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  };
  await waitFor(() => seenByA, 1, 15000);
  check("listener A saw event 1", seenByA.length === 1 && seenByA[0] === first.deployedAddress, JSON.stringify(seenByA));

  // Disconnect A entirely. Server-side listener + checkpoint must persist.
  await handleA.stop();
  await clientA.disconnect();
  console.log("listener A disconnected; submitting events 2 and 3 with nothing connected...");

  const second = await deployAndCreate(sdk, identity.lookup, factoryAddress);
  const third = await deployAndCreate(sdk, identity.lookup, factoryAddress);
  console.log(`event2 addr=${second.deployedAddress}, event3 addr=${third.deployedAddress}`);

  // Reconnect with the SAME listenerName.
  const seenByB: string[] = [];
  const clientB = await connect({ nodeUrl: NODE2_URL, wsUrl: NODE2_WS_URL, nodeId: "node2", identity: `resumeTest${runId}` });
  const handleB = await clientB.onBlockchainEvent(listenerName, factoryAddress, "AtomDeployed(address addr)", async (e) => {
    seenByB.push((e.data as { addr: string }).addr);
  });
  await waitFor(() => seenByB, 2, 20000);

  check("listener B did NOT replay event 1", !seenByB.includes(first.deployedAddress), JSON.stringify(seenByB));
  check("listener B saw event 2", seenByB.includes(second.deployedAddress), JSON.stringify(seenByB));
  check("listener B saw event 3", seenByB.includes(third.deployedAddress), JSON.stringify(seenByB));
  check("listener B saw EXACTLY 2 events (no duplicates, no extras)", seenByB.length === 2, JSON.stringify(seenByB));

  await handleB.stop();
  await clientB.disconnect();

  console.log(failures === 0 ? "\nSUCCESS: gap-free resume proven" : `\nFAILED: ${failures} check(s)`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
