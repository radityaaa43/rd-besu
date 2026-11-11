import PaladinClient, {
  ITransactionReceipt,
  NotoBalanceOfResult,
  NotoInstance,
  PaladinVerifier,
  PenteFactory,
} from "@lfdecentralizedtrust/paladin-sdk";
import * as fs from "fs";
import * as path from "path";
import {
  findLatestContractDataFile,
  getCachePath,
  nodeConnections,
  LONG_POLL_TIMEOUT,
  POLL_INTERVAL,
} from "paladin-example-common";
import { AtomFactory } from "../helpers/atom";
import { BondTracker } from "../helpers/bondtracker";
import type { ContractData } from "../tests/data-persistence";
import type { TradeRecord } from "./outright";

export const TRADES_FILE = "trades.jsonl";

export interface Participant {
  name: string;
  node: string;
  client: PaladinClient;
  verifier: PaladinVerifier;
}

export interface Platform {
  data: ContractData;
  dataDir: string;
  node1: PaladinClient;
  bondCustodian: PaladinVerifier;
  notoCash: NotoInstance;
  notoBond: NotoInstance;
  bondTracker: BondTracker;
  atomFactory: AtomFactory;
  investors: Map<string, Participant>;
}

// Reconnects to the bond series created by the latest `npm run start` in dataDir.
export async function loadPlatform(dataDir = getCachePath()): Promise<Platform> {
  const dataFile = findLatestContractDataFile(dataDir);
  if (!dataFile) throw new Error(`No contract data in ${dataDir}. Run \`npm run start\` first.`);
  const data: ContractData = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (!data.restrictedAtomFactoryAddress) {
    throw new Error(`${dataFile} has no restrictedAtomFactoryAddress. Run \`npm run start\` again.`);
  }
  if (!Array.isArray(data.investors)) {
    throw new Error(`${dataFile} is not in the multi-investor format. Run \`npm run start\` again.`);
  }

  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const node1 = clients[0];
  const [bondCustodian] = node1.getVerifiers(data.participants.bondCustodian);

  const group = await new PenteFactory(node1, "pente").resumePrivacyGroup({ id: data.issuerCustodianGroupId });
  if (group?.address !== data.issuerCustodianGroupAddress) {
    throw new Error("Issuer-custodian privacy group could not be resumed on node1");
  }

  const investors = new Map<string, Participant>();
  for (const inv of data.investors) {
    const idx = nodeConnections.findIndex((n) => n.id === inv.node);
    if (idx < 0) throw new Error(`Node ${inv.node} for ${inv.name} is not in the node config`);
    const client = clients[idx];
    investors.set(inv.name, { name: inv.name, node: inv.node, client, verifier: client.getVerifiers(inv.lookup)[0] });
  }

  return {
    data,
    dataDir,
    node1,
    bondCustodian,
    notoCash: new NotoInstance(node1, data.notoCashAddress),
    notoBond: new NotoInstance(node1, data.notoBondAddress),
    bondTracker: new BondTracker(group, data.bondTrackerAddress),
    atomFactory: new AtomFactory(node1, data.restrictedAtomFactoryAddress),
    investors,
  };
}

// units x price in the token's smallest unit. Exact decimal math: tokens are integers,
// so a fractional consideration (e.g. 3 x 1.1) is rejected rather than rounded.
export function computeConsideration(units: bigint, price: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!m) throw new Error(`price must be a positive decimal, got "${price}"`);
  const frac = m[2] ?? "";
  const scaled = BigInt(m[1] + frac);
  if (scaled === 0n) throw new Error("price must be greater than 0");
  const denom = 10n ** BigInt(frac.length);
  const total = units * scaled;
  if (total % denom !== 0n) {
    throw new Error(`${units} x ${price} is not a whole amount of cash; adjust units or price`);
  }
  return total / denom;
}

export function parseUnits(units: string | number): bigint {
  const s = String(units);
  if (!/^\d+$/.test(s) || BigInt(s) === 0n) throw new Error(`units must be a positive integer, got "${s}"`);
  return BigInt(s);
}

export function requireSuccess(receipt: ITransactionReceipt | undefined, step: string): ITransactionReceipt {
  if (receipt === undefined) throw new Error(`${step}: no receipt (timed out)`);
  if (receipt.failureMessage !== undefined || receipt.success === false) {
    throw new Error(`${step}: ${receipt.failureMessage ?? "failed"}`);
  }
  return receipt;
}

// Balances settle asynchronously after an atom executes; poll until they get there.
// `side` names which way the caller's balance moves, so another credit or debit on the same account while the trade runs does not
// turn a settled trade into a failure: a "credit" side waits for balance >= expected, a "debit" side for balance <= expected.
// "exact" is the old equality match. The side is a required argument, so a caller cannot forget it and silently get an exact match.
// A directional wait no longer proves that THIS trade's amounts moved (another trade may have moved the same balance): the lens does.
export type BalanceSide = "credit" | "debit" | "exact";
export async function waitForBalance(
  label: string,
  query: () => Promise<NotoBalanceOfResult>,
  expected: number | bigint,
  side: BalanceSide,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<NotoBalanceOfResult | undefined> {
  const timeoutMs = opts.timeoutMs ?? LONG_POLL_TIMEOUT;
  const pollMs = opts.pollMs ?? POLL_INTERVAL;
  const want = BigInt(expected);
  const reached = (total: string): boolean => {
    let got: bigint;
    try { got = BigInt(total); } catch { return false; }
    return side === "credit" ? got >= want : side === "debit" ? got <= want : got === want;
  };
  const startTime = Date.now();
  while (true) {
    const balance = await query();
    if (reached(balance.totalBalance)) {
      if (balance.totalBalance !== String(want)) console.log(`${label}: ${side} side reached, expected ${side === "credit" ? ">=" : "<="} ${want}, now ${balance.totalBalance}`);
      return balance;
    }
    if (Date.now() - startTime > timeoutMs) {
      console.error(`${label}: expected ${side === "credit" ? ">=" : side === "debit" ? "<=" : ""}${want}, still ${balance.totalBalance} after ${timeoutMs / 1000}s`);
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function loadTrades(dataDir: string, notoBondAddress: string): TradeRecord[] {
  const file = path.join(dataDir, TRADES_FILE);
  if (!fs.existsSync(file)) return [];
  const latest = new Map<string, TradeRecord>();
  // Append-only log: a later line for the same tradeId (e.g. a recovery) supersedes earlier ones.
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const t = JSON.parse(line) as TradeRecord;
    if (t.notoBondAddress === notoBondAddress) latest.set(t.tradeId, t);
  }
  return Array.from(latest.values());
}

export function appendTrade(dataDir: string, trade: TradeRecord) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, TRADES_FILE), JSON.stringify(trade) + "\n");
}
