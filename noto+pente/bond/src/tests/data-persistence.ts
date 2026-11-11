/*
 * Copyright © 2025 Kaleido, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import PaladinClient, { NotoInstance, PenteFactory } from "@lfdecentralizedtrust/paladin-sdk";
import * as fs from "fs";
import { nodeConnections, findLatestContractDataFile, getCachePath } from "paladin-example-common";
import { computeConsideration, loadTrades } from "../lib/platform";

const logger = console;

export interface Balance {
  totalBalance: string;
  totalStates: string;
  overflow: boolean;
}

export interface InvestorRecord {
  name: string;
  node: string;
  lookup: string;
  investorCustodianGroupId: string;
  investorCustodianGroupAddress: string;
  bondSubscriptionAddress: string;
  atomAddress: string;
  cashLockId: string;
  bondLockId: string;
  cashUnlockCall: string;
  bondUnlockCall: string;
  finalBalances: { cash: Balance; bond: Balance };
}

export interface ContractData {
  notoCashAddress: string;
  notoBondAddress: string;
  cashGroupId: string;
  cashGroupAddress: string;
  cashTrackerAddress: string;
  issuerCustodianGroupId: string;
  issuerCustodianGroupAddress: string;
  bondTrackerAddress: string;
  bondTrackerPublicAddress: string;
  // Upstream AtomFactory: only in data dirs written before issuance moved to RestrictedAtom.
  atomFactoryAddress?: string;
  // Issuance (RestrictedBondSubscription) and platform trades (bond/src/lib/outright.ts) both settle through this one.
  restrictedAtomFactoryAddress: string;
  bondDetails: {
    issueDate: number;
    maturityDate: number;
    faceValue: number;
    discountPrice: number;
    minimumDenomination: number;
    bondSupply: number;
    bondUnitsPerInvestor: number;
    cashPerInvestor: number;
    initialCashPerInvestor: number;
  };
  investors: InvestorRecord[];
  custodianFinalBalances: { cash: Balance; bond: Balance };
  participants: {
    cashIssuer: string;
    bondIssuer: string;
    bondCustodian: string;
  };
  timestamp: string;
}

function expectEqual(label: string, found: string, expected: string): boolean {
  if (found !== expected) {
    logger.error(`ERROR - ${label}: expected ${expected}, found ${found}`);
    return false;
  }
  logger.log(`OK - ${label}: ${found}`);
  return true;
}

async function main(): Promise<boolean> {
  if (nodeConnections.length < 4) {
    logger.error("The environment config must provide 4 nodes for this scenario.");
    return false;
  }
  const clients = nodeConnections.map((node) => new PaladinClient(node.clientOptions));
  const paladin1 = clients[0];

  // STEP 1: Load saved contract data
  logger.log("STEP 1: Loading saved contract data...");
  const dataFile = findLatestContractDataFile(getCachePath());
  if (!dataFile) {
    logger.error("STEP 1: No contract data files found. Run `npm run start` first.");
    return false;
  }
  const data: ContractData = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (!Array.isArray(data.investors)) {
    logger.error(`STEP 1: ${dataFile} is not in the multi-investor format. Run \`npm run start\` again.`);
    return false;
  }
  logger.log(`STEP 1: Loaded ${dataFile} (${data.investors.length} investors)`);

  // STEP 2: Recreate contract connections and resume privacy groups
  logger.log("STEP 2: Recreating contract connections...");
  const [bondCustodian] = paladin1.getVerifiers(data.participants.bondCustodian);
  const notoCash = new NotoInstance(paladin1, data.notoCashAddress);
  const notoBond = new NotoInstance(paladin1, data.notoBondAddress);
  const penteFactory = new PenteFactory(paladin1, "pente");
  const cashGroup = await penteFactory.resumePrivacyGroup({ id: data.cashGroupId });
  const issuerCustodianGroup = await penteFactory.resumePrivacyGroup({ id: data.issuerCustodianGroupId });
  if (cashGroup?.address !== data.cashGroupAddress) {
    logger.error("STEP 2: Cash privacy group could not be resumed or address mismatch!");
    return false;
  }
  if (issuerCustodianGroup?.address !== data.issuerCustodianGroupAddress) {
    logger.error("STEP 2: Issuer-custodian privacy group could not be resumed or address mismatch!");
    return false;
  }
  logger.log("STEP 2: Cash and issuer-custodian privacy groups resumed");

  const d = data.bondDetails;
  let ok = true;

  // Secondary market: settled outright trades move bond and cash between investors.
  const trades = loadTrades(getCachePath(), data.notoBondAddress);
  const settled = trades.filter((t) => t.status === "SETTLED");
  logger.log(`STEP 2: ${trades.length} outright trade(s) recorded, ${settled.length} settled`);
  for (const t of trades.filter((t) => t.status === "ROLLED_BACK")) {
    logger.log(`INFO - trade ${t.tradeId} rolled back after ${t.failedStep} (no balance effect)`);
  }
  for (const t of trades.filter((t) => t.status === "PENDING")) {
    // a PENDING line that was never superseded: the process died mid-trade, so funds may still be locked (recoverTrade refuses it; check the locks by hand)
    logger.warn(`WARN - trade ${t.tradeId} is PENDING (lock ids bond ${t.bondLockId ?? "-"}, cash ${t.cashLockId ?? "-"}): a crash may have left funds locked`);
  }
  for (const t of trades.filter((t) => t.status === "FAILED")) {
    logger.warn(`WARN - trade ${t.tradeId} FAILED at ${t.failedStep}: ${t.error}; ${t.openLocks?.length ?? 0} open lock(s) need an operator`);
  }
  const bondDelta = new Map<string, bigint>();
  const cashDelta = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  for (const t of settled) {
    let expectedConsideration: bigint | undefined;
    try {
      expectedConsideration = computeConsideration(BigInt(t.units), t.price);
    } catch {
      expectedConsideration = undefined;
    }
    if (String(expectedConsideration) !== t.consideration || !t.atomAddress || !t.bondLockId || !t.cashLockId) {
      logger.error(`ERROR - trade ${t.tradeId} record is inconsistent or incomplete`);
      ok = false;
      continue;
    }
    add(bondDelta, t.seller, -BigInt(t.units));
    add(bondDelta, t.buyer, BigInt(t.units));
    add(cashDelta, t.seller, BigInt(t.consideration));
    add(cashDelta, t.buyer, -BigInt(t.consideration));
  }

  // STEP 3: Each investor (on its own node) holds primary allocation +/- settled trades
  logger.log("STEP 3: Verifying investor balances from each investor's own node...");
  for (const inv of data.investors) {
    const conn = nodeConnections.findIndex((n) => n.id === inv.node);
    if (conn < 1) {
      logger.error(`STEP 3: ${inv.name} node ${inv.node} must be one of node2-node4`);
      return false;
    }
    const client = clients[conn];
    const [investor] = client.getVerifiers(inv.lookup);
    const group = await penteFactory.using(client).resumePrivacyGroup({ id: inv.investorCustodianGroupId });
    if (group?.address !== inv.investorCustodianGroupAddress) {
      logger.error(`STEP 3: ${inv.name} investor-custodian privacy group not resumable from ${inv.node}`);
      ok = false;
    }
    const bond = await notoBond.using(client).balanceOf(investor, { account: investor.lookup });
    const cash = await notoCash.using(client).balanceOf(investor, { account: investor.lookup });
    const primaryBond = BigInt(d.bondUnitsPerInvestor);
    const primaryCash = BigInt(d.initialCashPerInvestor - d.cashPerInvestor);
    ok = expectEqual(`${inv.name} saved primary bond`, inv.finalBalances.bond.totalBalance, String(primaryBond)) && ok;
    ok = expectEqual(`${inv.name} saved primary cash`, inv.finalBalances.cash.totalBalance, String(primaryCash)) && ok;
    const expectedBond = primaryBond + (bondDelta.get(inv.name) ?? 0n);
    const expectedCash = primaryCash + (cashDelta.get(inv.name) ?? 0n);
    ok = expectEqual(`${inv.name}@${inv.node} bond`, bond.totalBalance, String(expectedBond)) && ok;
    ok = expectEqual(`${inv.name}@${inv.node} cash`, cash.totalBalance, String(expectedCash)) && ok;
    if (!inv.atomAddress || !inv.cashLockId || !inv.bondLockId || !inv.cashUnlockCall || !inv.bondUnlockCall) {
      logger.error(`STEP 3: ${inv.name} is missing atom/lock details`);
      ok = false;
    }
  }

  // STEP 4: Custodian (node1) received all payments and released the sold bonds
  logger.log("STEP 4: Verifying custodian balances on node1...");
  const n = data.investors.length;
  const custodianBond = await notoBond.balanceOf(bondCustodian, { account: bondCustodian.lookup });
  const custodianCash = await notoCash.balanceOf(bondCustodian, { account: bondCustodian.lookup });
  ok = expectEqual("custodian bond", custodianBond.totalBalance, String(d.bondSupply - n * d.bondUnitsPerInvestor)) && ok;
  ok = expectEqual("custodian cash", custodianCash.totalBalance, String(n * d.cashPerInvestor)) && ok;
  ok = expectEqual("custodian bond vs saved", custodianBond.totalBalance, data.custodianFinalBalances.bond.totalBalance) && ok;
  ok = expectEqual("custodian cash vs saved", custodianCash.totalBalance, data.custodianFinalBalances.cash.totalBalance) && ok;

  if (!ok) {
    logger.error("\nFAILED: Verification found mismatches (see above)");
    return false;
  }
  logger.log("\nSUCCESS: Verification completed!");
  return true;
}

if (require.main === module) {
  main()
    .then((success: boolean) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Exiting with uncaught error");
      console.error(err);
      process.exit(1);
    });
}
