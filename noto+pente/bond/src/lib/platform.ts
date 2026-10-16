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
    atomFactory: new AtomFactory(node1, data.atomFactoryAddress),
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

// Balances settle asynchronously after an atom executes; poll until they match.
export async function waitForBalance(
  label: string,
  query: () => Promise<NotoBalanceOfResult>,
  expected: number | bigint
): Promise<NotoBalanceOfResult | undefined> {
  const startTime = Date.now();
  while (true) {
    const balance = await query();
    if (balance.totalBalance === String(expected)) return balance;
    if (Date.now() - startTime > LONG_POLL_TIMEOUT) {
      console.error(`${label}: expected ${expected}, still ${balance.totalBalance} after ${LONG_POLL_TIMEOUT / 1000}s`);
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
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
