/*
 * Zeto_AnonNullifier V1 smoke (2026-11-09 switch): fresh token from ZETO_V1 -> BI mints 100 to bankA -> bankA transfers 40 to bankB.
 * Asserts: balances 60/40; the transfer's on-chain inputs are nullifiers (none equals the spent mint commitment);
 * BI's ledger verifies bankA's report of the transfer outputs. No DvP. Run under the cluster lock:
 *   flock /tmp/lensa-paladin.lock npx ts-node spike-nullifier-smoke.ts
 */
import { PenteFactory, ZetoFactory, algorithmZetoSnarkBJJ, IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X } from "@lfdecentralizedtrust/paladin-sdk";
import { LONG_POLL_TIMEOUT } from "./src/common";
import { ZETO_V1 } from "./src/zeto-v1";
import { BiLedger, REPORT_TOPIC, buildReport, chainIO } from "./src/bi-report";
import { PaladinClient, nodeConnections, party } from "./src/flows";

const nodes = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!pass) process.exitCode = 1;
};

async function main() {
  const [bi, bankA, bankB] = ["bi@node1", "bankA@node2", "bankB@node3"].map((l) => party(nodes, l));
  const fromBlock = await bi.c.bidx.getConfirmedBlockHeight();
  const zeto = await new ZetoFactory(bi.c, "zeto").newZeto(bi.v, { ...ZETO_V1 }).waitForDeploy(LONG_POLL_TIMEOUT);
  if (!zeto) throw new Error(`BLOCKED: ${ZETO_V1.tokenName} deploy returned no instance`);
  console.log(`zeto ${ZETO_V1.tokenName} ${zeto.address}`);

  const mint = await zeto.using(bi.c).mint(bi.v, { mints: [{ to: bankA.v, amount: 100, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT);
  if (mint?.success !== true) throw new Error(`BLOCKED: mint failed: ${mint?.failureMessage}`);
  const minted = (await chainIO(bi.c, mint.transactionHash!, zeto.address)).outputs.map(String);

  const bal = async (p: typeof bankA, want: string) => {
    let b = "?";
    for (const t = Date.now(); b !== want && Date.now() - t < LONG_POLL_TIMEOUT; await sleep(1000)) b = (await zeto.using(p.c).balanceOf(p.v, { account: p.lookup })).totalBalance;
    return b;
  };
  check("bankA balance after mint", (await bal(bankA, "100")) === "100", "100");

  const t0 = Date.now();
  const tx = await zeto.using(bankA.c).transfer(bankA.v, { transfers: [{ to: bankB.v, amount: 40, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT);
  check("nullifier transfer", tx?.success === true, `${tx?.transactionHash ?? tx?.failureMessage} in ${Date.now() - t0} ms`);
  if (tx?.success !== true) return;
  check("bankA balance", (await bal(bankA, "60")) === "60", "60");
  check("bankB balance", (await bal(bankB, "40")) === "40", "40");

  const io = await chainIO(bi.c, tx.transactionHash!, zeto.address);
  const inputs = io.inputs.map(String);
  check("inputs are nullifiers", inputs.length > 0 && !inputs.some((i) => minted.includes(i)), `inputs=${inputs.length}, spent mint commitment hidden=${!inputs.some((i) => minted.includes(i))}`);

  const group = await new PenteFactory(bankA.c, "pente").newPrivacyGroup({ name: `nullifier-smoke-${Date.now()}`, members: [bankA.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT);
  if (!group) throw new Error("BLOCKED: privacy group deploy returned nothing");
  await bankA.c.pgroup.sendMessage({ domain: "pente", group: group.group.id, topic: REPORT_TOPIC, data: await buildReport(bankA.c, bankA.lookup, "RD", zeto.address, tx.transactionHash!) });
  const ownerBook = new Map(await Promise.all([bankA, bankB].map(async (p) => [(await bi.c.ptx.resolveVerifier(p.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)).toLowerCase(), p.lookup] as [string, string])));
  const ledger = new BiLedger(bi.c, new Map([[zeto.address.toLowerCase(), "RD"]]), new Map(), ownerBook, fromBlock);
  const want = io.outputs.map(String);
  for (const t = Date.now(); want.some((c) => !ledger.verified.has(c)) && Date.now() - t < LONG_POLL_TIMEOUT; await sleep(1000)) await ledger.pollReports();
  const owners = want.map((c) => ledger.ownerOf(ledger.verified.get(c)?.output.owner ?? "?"));
  check("BI verifies transfer outputs", want.every((c) => ledger.verified.has(c)) && !ledger.mismatches.length, `owners=${owners.join(",")}, mismatch=${ledger.mismatches.length}`);
  console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
}
main().catch((e) => { console.error(e); process.exit(2); });
