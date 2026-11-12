/*
 * R2-chain (analyst row, 2026-11-12): ONE Zeto RD transfer A->B (amount 1) through bank A's OWN gateway (bank-gw-2: Envoy + OPA, A's party mTLS), while BI (node1) is offline,
 * then the same post-settlement report attempt Lensa makes (pgroup_sendMessage topic zeto-report-v1 to A's report group). Core + tests: src/r2-chain.ts, test/r2-chain.test.ts.
 *
 *   dry run (default, read-only):  R2_STATE=<frontend state/zeto.json> npx ts-node r2-chain.ts
 *   real run (node1 scaled to 0):  flock /tmp/lensa-paladin.lock npx ts-node r2-chain.ts --execute --amount 1
 *
 * Env: R2_A_URL (default https://127.0.0.1:31648), R2_A_SERVERNAME (bank-gw-2), R2_A_DIR (~/.opa-mtls-party/A: ca.crt, lensa.crt, lensa.key),
 *      R2_BI_URL (https://127.0.0.1:31548), R2_BI_SERVERNAME (bank-gw-1), R2_BI_DIR (~/.opa-mtls-party/BI), R2_STATE (RD address + report group of A).
 * ONE client talks to A's gateway; the BI gateway is only asked a read to learn that node1 is down (a gateway whose node is down answers with an error / times out).
 * Prints the tx hash, receipt, block, A's balance before/after and the report OUTCOME only (class code, no payload). Never retries.
 */
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import PaladinClient, { ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { reportTo, transfer, within, type Party } from "./src/flows";
import { R2ChainError, runR2Chain } from "./src/r2-chain";

const env = process.env;
const home = os.homedir();
const client = (url: string, dir: string, servername: string) =>
  new PaladinClient({
    url,
    requestConfig: {
      httpsAgent: new https.Agent({
        ca: fs.readFileSync(path.join(dir, "ca.crt")),
        cert: fs.readFileSync(path.join(dir, "lensa.crt")),
        key: fs.readFileSync(path.join(dir, "lensa.key")),
        servername,
        keepAlive: true,
      }),
      timeout: 15000,
    },
  });
const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);

async function main() {
  const state = JSON.parse(fs.readFileSync(env.R2_STATE ?? "/home/ecs-user/project/rd/platform-ekplorasi/frontend/server/state/zeto.json", "utf8"));
  const cA = client(env.R2_A_URL ?? "https://127.0.0.1:31648", env.R2_A_DIR ?? path.join(home, ".opa-mtls-party/A"), env.R2_A_SERVERNAME ?? "bank-gw-2");
  const cBI = client(env.R2_BI_URL ?? "https://127.0.0.1:31548", env.R2_BI_DIR ?? path.join(home, ".opa-mtls-party/BI"), env.R2_BI_SERVERNAME ?? "bank-gw-1");
  const A: Party = { lookup: "bankA@node2", c: cA, v: cA.getVerifiers("bankA@node2")[0]! };
  const B: Party = { lookup: "bankB@node3", c: cA, v: cA.getVerifiers("bankB@node3")[0]! }; // resolved through A's node; never a B client
  const zeto = new ZetoInstance(cA, state.rd);
  let settledReceipt: any;
  const out: string[] = [];
  const say = (l: string) => { const s = `${new Date().toISOString()} ${l}`; console.log(s); out.push(s); };
  await runR2Chain(
    {
      biDown: async () => within(cBI.ptx.queryPendingTransactions({ limit: 1 }, false), 10000, "BI read").then(() => false, () => true),
      balanceA: async () => BigInt((await zeto.using(cA).balanceOf(A.v, { account: A.lookup })).totalBalance),
      transfer: async (amount) => {
        const s = await transfer(A, zeto, B, amount);
        settledReceipt = s.receipt;
        return { success: s.receipt?.success, transactionHash: s.receipt?.transactionHash, blockNumber: s.receipt?.blockNumber, failureMessage: s.receipt?.failureMessage };
      },
      report: async () => { await reportTo(state.groups.A, A, "RD", state.rd, settledReceipt); },
    },
    { execute: argv.includes("--execute"), amount: Number(opt("--amount") ?? "1") },
    say
  );
}
main().catch((e) => {
  const m = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted>");
  console.log(`R2-CHAIN ${e instanceof R2ChainError ? `STOP ${e.step}` : "FAIL setup"}: ${m}`);
  process.exit(1);
});
