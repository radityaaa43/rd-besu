/*
 * LIVE Zeto V1 lock lifecycle check on ONE party's node (zeto S21 gate "Lensa live lock check"): through that party's own
 * gateway and identity runs createLock -> prepareSpendLock -> delegateLock (to the owner's own eth address) -> cancelLock,
 * prints the balance before/after each step. Moves LOCK_CHECK_AMOUNT units into a lock and cancels it (net zero).
 * Last line: `L6 zeto LOCK: PASS` (exit 0) or `L6 zeto LOCK: FAIL <step>: <message>` (exit 1).
 *
 *   LOCK_CHECK_URL=https://<party gateway>:8548 LOCK_CHECK_TOKEN=<Zeto token address> LENSA_GW_MTLS_DIR=<dir> npx ts-node lock-check.ts
 *
 * Env: LOCK_CHECK_URL (required), LOCK_CHECK_TOKEN (required), LOCK_CHECK_OWNER (default bankA@node2),
 * LOCK_CHECK_TO (default bankB@node3, resolved through the owner's node), LOCK_CHECK_AMOUNT (default 1, whole units),
 * LOCK_CHECK_SERVERNAME (optional TLS servername), LENSA_GW_MTLS_DIR (ca.crt, lensa.crt, lensa.key; as src/common.ts).
 */
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import PaladinClient, { ZetoInstance } from "@lfdecentralizedtrust/paladin-sdk";
import { cancelLock, createLock, delegateLock, prepareSpend, LockParty } from "./src/zeto-v1";
import { LockCheckError, runLockCheck } from "./src/lock-check";

const stamp = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const fail = (what: string): never => {
  console.log(`L6 zeto LOCK: FAIL ${what}`);
  process.exit(1);
};
// Same 32-byte-hex scrub as src/lock-check.ts: nothing secret-looking reaches the output.
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted>");

function config() {
  const env = process.env;
  if (!env.LOCK_CHECK_URL) fail("config: LOCK_CHECK_URL missing");
  if (!env.LOCK_CHECK_TOKEN) fail("config: LOCK_CHECK_TOKEN missing");
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.LOCK_CHECK_TOKEN!)) fail("config: LOCK_CHECK_TOKEN is not an address");
  const amountText = env.LOCK_CHECK_AMOUNT ?? "1";
  if (!/^[1-9][0-9]*$/.test(amountText)) fail("config: LOCK_CHECK_AMOUNT must be a positive integer");
  const owner = env.LOCK_CHECK_OWNER ?? "bankA@node2";
  const to = env.LOCK_CHECK_TO ?? "bankB@node3";
  for (const [k, v] of [["LOCK_CHECK_OWNER", owner], ["LOCK_CHECK_TO", to]]) if (!/^[^@\s]+@[^@\s]+$/.test(v)) fail(`config: ${k} must look like name@node`);
  return { url: env.LOCK_CHECK_URL!, token: env.LOCK_CHECK_TOKEN!, owner, to, amount: BigInt(amountText) };
}

function newClient(url: string): PaladinClient {
  const dir = process.env.LENSA_GW_MTLS_DIR;
  if (!dir) return new PaladinClient({ url });
  let agent: https.Agent;
  try {
    agent = new https.Agent({
      ca: fs.readFileSync(path.join(dir, "ca.crt")),
      cert: fs.readFileSync(path.join(dir, "lensa.crt")),
      key: fs.readFileSync(path.join(dir, "lensa.key")),
      keepAlive: true,
      ...(process.env.LOCK_CHECK_SERVERNAME ? { servername: process.env.LOCK_CHECK_SERVERNAME } : {}),
    });
  } catch {
    return fail("config: cannot read ca.crt / lensa.crt / lensa.key from LENSA_GW_MTLS_DIR");
  }
  return new PaladinClient({ url: url.replace(/^http:/, "https:"), requestConfig: { httpsAgent: agent } });
}

async function main() {
  const cfg = config();
  const c = newClient(cfg.url);
  const party = (lookup: string): LockParty => ({ lookup, c, v: c.getVerifiers(lookup)[0] });
  const owner = party(cfg.owner);
  const to = party(cfg.to);
  const zeto = new ZetoInstance(c, cfg.token);
  stamp(`lock check: owner=${cfg.owner} to=${cfg.to} token=${cfg.token} amount=${cfg.amount}`);

  await runLockCheck(
    {
      balance: async () => BigInt((await zeto.using(c).balanceOf(owner.v, { account: owner.lookup })).totalBalance),
      createLock: (amount) => createLock(zeto, owner, to, amount),
      prepareSpend: (lockId) => prepareSpend(zeto, owner, lockId),
      delegateToSelf: async (lockId) => delegateLock(zeto, owner, lockId, await owner.v.address()),
      cancel: (lockId) => cancelLock(zeto, owner, lockId),
    },
    { amount: cfg.amount },
    stamp
  );
  console.log("L6 zeto LOCK: PASS");
}

main().catch((e) => {
  fail(e instanceof LockCheckError ? `${e.step}: ${e.message}` : `setup: ${clean(e)}`);
});
