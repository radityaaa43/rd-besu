/*
 * Private-mint spike (Lensa Privasi spec §7a.3): can BI issue RD privately with Zeto `mint`, with
 * no setERC20 and no public tx to a Zeto contract?
 *   fresh Zeto_Anon (deployed by bi@node1) -> mint 100 to bankA@node2 -> bankA reports to BI
 * Asserts: bankA balanceOf = 100, node4 (bankC) holds 0 states, BI's ledger verifies the output.
 * Never calls setERC20. Run under the cluster lock:
 *   flock /tmp/lensa-paladin.lock npx ts-node spike-private-mint.ts
 */
import PaladinClient, {
  IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X,
  PenteFactory,
  ZetoFactory,
  algorithmZetoSnarkBJJ,
} from "@lfdecentralizedtrust/paladin-sdk";
import { LONG_POLL_TIMEOUT, nodeConnections } from "./src/common";
import { BiLedger, REPORT_TOPIC, buildReport, chainOutputs } from "./src/bi-report";

const nodes = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
const party = (lookup: string) => {
  const c = nodes[Number(lookup.split("@node")[1]) - 1];
  return { lookup, c, v: c.getVerifiers(lookup)[0] };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!pass) process.exitCode = 1;
};
async function visibleStates(c: PaladinClient, address: string) {
  let n = 0;
  for (const s of await c.pstate.listSchemas("zeto")) n += (await c.pstate.queryContractStates("zeto", address, s.id, { limit: 1000 } as any, "all")).length;
  return n;
}

async function main() {
  const [bi, bankA, bankC] = ["bi@node1", "bankA@node2", "bankC@node4"].map(party);
  const fromBlock = await bi.c.bidx.getConfirmedBlockHeight();

  const zeto = await new ZetoFactory(bi.c, "zeto").newZeto(bi.v, { tokenName: "Zeto_Anon" }).waitForDeploy(LONG_POLL_TIMEOUT);
  if (!zeto) throw new Error("BLOCKED: Zeto_Anon deploy returned no instance within 120s");
  console.log(`zeto ${zeto.address}`);

  const t0 = Date.now();
  const rcpt = await zeto.using(bi.c).mint(bi.v, { mints: [{ to: bankA.v, amount: 100, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT);
  if (rcpt?.success !== true) throw new Error(`BLOCKED: mint failed: ${rcpt?.failureMessage ?? "no receipt within 120s"}`);
  console.log(`mint receipt ${rcpt.transactionHash} in ${Date.now() - t0} ms`);

  let bal = "0";
  for (const start = Date.now(); bal !== "100" && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(1000)) bal = (await zeto.using(bankA.c).balanceOf(bankA.v, { account: bankA.lookup })).totalBalance;
  check("bankA balanceOf", bal === "100", `totalBalance=${bal}`);

  const group = await new PenteFactory(bankA.c, "pente").newPrivacyGroup({ name: `spike-private-mint-${Date.now()}`, members: [bankA.v, bi.v], evmVersion: "shanghai", externalCallsEnabled: true }).waitForDeploy(LONG_POLL_TIMEOUT);
  if (!group) throw new Error("BLOCKED: privacy group deploy returned nothing within 120s");
  const rep = await buildReport(bankA.c, bankA.lookup, "RD", zeto.address, rcpt.transactionHash);
  await bankA.c.pgroup.sendMessage({ domain: "pente", group: group.group.id, topic: REPORT_TOPIC, data: rep });

  const addressBook = new Map([[(await bi.c.ptx.resolveVerifier(bankA.lookup, "ecdsa:secp256k1", "eth_address")).toLowerCase(), bankA.lookup]]);
  const ownerBook = new Map([[(await bi.c.ptx.resolveVerifier(bankA.lookup, algorithmZetoSnarkBJJ("zeto"), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)).toLowerCase(), bankA.lookup]]);
  const ledger = new BiLedger(bi.c, new Map([[zeto.address.toLowerCase(), "RD"]]), addressBook, ownerBook, fromBlock);
  const want = (await chainOutputs(bi.c, rcpt.transactionHash, zeto.address)).map(String);
  const missing = () => want.filter((c) => !ledger.verified.has(c));
  for (const start = Date.now(); missing().length && Date.now() - start < LONG_POLL_TIMEOUT; await sleep(1000)) await ledger.pollReports();
  check("BI ledger verifies mint output", want.length === 1 && !missing().length && !ledger.mismatches.length, `${want.length - missing().length}/${want.length} verified, mismatch=${ledger.mismatches.length}, outputs=${want}`);

  const n = await visibleStates(bankC.c, zeto.address);
  check("bankC@node4 states", n === 0, `visibleStates=${n}`);
  console.log(process.exitCode ? "SPIKE FAILED" : "SPIKE PASSED: privateMint=true");
}
main().catch((e) => { console.error(e); process.exit(2); });
