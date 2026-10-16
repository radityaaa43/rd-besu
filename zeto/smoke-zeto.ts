/*
 * Smoke check for bootstrap-zeto.ts output: the template's private transfer + withdraw, on
 * both tokens, 1 unit each. RD: investor2 -> investor3 private, investor3 withdraws to ERC20.
 * DFABI: bondCustodian -> investor2 private, investor2 withdraws to ERC20. Asserts every
 * balance delta; exits 1 on any mismatch. Moves 1 real unit per token on the live ledger.
 *
 * Run from this directory (port-forwards up):
 *   npx ts-node smoke-zeto.ts
 */
import * as fs from "fs";
import * as path from "path";
import PaladinClient, { PaladinVerifier, TransactionType, ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, LONG_POLL_TIMEOUT, checkReceipt, nodeConnections } from "./src/common";
import erc20Artifact from "./abis/SampleERC20.json";

const OUT_FILE = path.join(__dirname, "out", "zeto-contract-data.json");
const NODE_IDX: Record<string, number> = { node1: 0, node2: 1, node3: 2, node4: 3 };

type Party = { client: PaladinClient; verifier: PaladinVerifier };

function party(clients: PaladinClient[], lookup: string): Party {
  const client = clients[NODE_IDX[lookup.split("@")[1]]];
  return { client, verifier: client.getVerifiers(lookup)[0] };
}

async function balances(zeto: ZetoInstance, erc20: string, p: Party) {
  const priv = await zeto.using(p.client).balanceOf(p.verifier, { account: p.verifier.lookup });
  const pub = await p.client.ptx.call({
    type: TransactionType.PUBLIC,
    abi: erc20Artifact.abi,
    function: "balanceOf",
    to: erc20,
    from: p.verifier.lookup,
    data: { account: await p.verifier.address() },
  });
  return { priv: BigInt(priv.totalBalance), pub: BigInt(pub[0]) };
}

function expect(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) throw new Error(`${label}: got ${actual}, expected ${expected}`);
  console.log(`  ok ${label} = ${actual}`);
}

async function check(name: string, token: { zetoAddress: string; erc20Address: string }, from: Party, to: Party) {
  console.log(`${name}: ${from.verifier.lookup} -> ${to.verifier.lookup}`);
  const zeto = new ZetoInstance(from.client, token.zetoAddress);
  const a0 = await balances(zeto, token.erc20Address, from);
  const b0 = await balances(zeto, token.erc20Address, to);

  const t = await zeto.using(from.client).transfer(from.verifier, { transfers: [{ to: to.verifier, amount: 1, data: "0x" }] }).waitForReceipt(LONG_POLL_TIMEOUT);
  if (!checkReceipt(t)) throw new Error(`${name} transfer failed`);
  const w = await zeto.using(to.client).withdraw(to.verifier, { amount: 1 }).waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(w)) throw new Error(`${name} withdraw failed`);

  const a1 = await balances(zeto, token.erc20Address, from);
  const b1 = await balances(zeto, token.erc20Address, to);
  expect(`${name} sender private`, a1.priv, a0.priv - 1n);
  expect(`${name} receiver private`, b1.priv, b0.priv);
  expect(`${name} receiver public`, b1.pub, b0.pub + 1n);
}

async function main() {
  const data = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  await check("RD", data.rd, party(clients, "investor2@node2"), party(clients, "investor3@node3"));
  await check("DFABI", data.dfabi, party(clients, "bondCustodian@node1"), party(clients, "investor2@node2"));
  console.log("Zeto smoke: PASS");
}

main().catch((err) => {
  console.error("Zeto smoke: FAIL", err);
  process.exit(1);
});
