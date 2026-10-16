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
import PaladinClient, {
  NotoInstance,
  PenteFactory,
} from "@lfdecentralizedtrust/paladin-sdk";
import * as fs from 'fs';
import { nodeConnections, findLatestContractDataFile, getCachePath } from "paladin-example-common";

const logger = console;

export interface ContractData {
  atomFactoryAddress: string;
  notoCashAddress: string;
  notoAssetAddress: string;
  assetGroupId: string;
  assetGroupAddress: string;
  assetTrackerAddress: string;
  cashGroupId: string;
  cashGroupAddress: string;
  cashTrackerAddress: string;
  atomAddress: string;
  swapDetails: {
    assetAmount: number;
    cashAmount: number;
    assetLockId: string;
    cashLockId: string;
    assetUnlockCall: string;
    cashUnlockCall: string;
  };
  finalBalances: {
    asset: {
      investor1: { totalBalance: string; totalStates: string; overflow: boolean };
      investor2: { totalBalance: string; totalStates: string; overflow: boolean };
    };
    cash: {
      investor1: { totalBalance: string; totalStates: string; overflow: boolean };
      investor2: { totalBalance: string; totalStates: string; overflow: boolean };
    };
  };
  participants: {
    cashIssuer: string;
    assetIssuer: string;
    investor1: string;
    investor2: string;
  };
  timestamp: string;
}

async function main(): Promise<boolean> {
  if (nodeConnections.length < 4) {
    logger.error("The environment config must provide at least 4 nodes for this scenario.");
    return false;
  }

  const clients = nodeConnections.map(node => new PaladinClient(node.clientOptions));
  const paladin1 = clients[0];
  const paladin2 = clients[2];
  const paladin3 = clients[3];

  // STEP 1: Load the saved contract data
  logger.log("STEP 1: Loading saved contract data...");
  const dataDir = getCachePath();
  const dataFile = findLatestContractDataFile(dataDir);

  if (!dataFile) {
    logger.error(`STEP 1: No contract data files found in ${dataDir}`);
    logger.error("Please run the original script first to deploy the contracts and save the data.");
    return false;
  }

  const contractData: ContractData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  logger.log(`STEP 1: Loaded contract data from ${dataFile}`);

  logger.log("\n=== CACHED DATA SUMMARY ===");
  logger.log(`Data File: ${dataFile}`);
  logger.log(`Timestamp: ${contractData.timestamp}`);
  logger.log(`Atom Factory Address: ${contractData.atomFactoryAddress}`);
  logger.log(`Noto Cash Address: ${contractData.notoCashAddress}`);
  logger.log(`Noto Asset Address: ${contractData.notoAssetAddress}`);
  logger.log(`Asset Group ID: ${contractData.assetGroupId}`);
  logger.log(`Cash Group ID: ${contractData.cashGroupId}`);
  logger.log(`Atom Address: ${contractData.atomAddress}`);
  logger.log(`Asset Amount: ${contractData.swapDetails.assetAmount}`);
  logger.log(`Cash Amount: ${contractData.swapDetails.cashAmount}`);
  logger.log("=============================\n");

  // STEP 2: Get verifiers and recreate contract connections
  logger.log("STEP 2: Recreating contract connections...");
  const [cashIssuer, assetIssuer] = paladin1.getVerifiers(
    `cashIssuer@${nodeConnections[0].id}`,
    `assetIssuer@${nodeConnections[0].id}`
  );
  const [investor1] = paladin2.getVerifiers(`investor1@${nodeConnections[2].id}`);
  const [investor2] = paladin3.getVerifiers(`investor2@${nodeConnections[3].id}`);

  const notoCash = new NotoInstance(paladin1, contractData.notoCashAddress);
  const notoAsset = new NotoInstance(paladin1, contractData.notoAssetAddress);

  const penteFactory = new PenteFactory(paladin1, "pente");
  const assetGroup = await penteFactory.resumePrivacyGroup({
    id: contractData.assetGroupId,
  });

  if (!assetGroup) {
    logger.error("STEP 2: Failed to retrieve asset privacy group!");
    return false;
  }

  logger.log("STEP 2: Contract connections recreated successfully!");

  // STEP 3: Verify asset token balances
  logger.log("STEP 3: Verifying asset token balances...");
  try {
    const currentAssetBalanceInvestor1 = await notoAsset.using(paladin2).balanceOf(investor1, { account: investor1.lookup });
    const currentAssetBalanceInvestor2 = await notoAsset.using(paladin3).balanceOf(investor2, { account: investor2.lookup });

    logger.log(`STEP 3: Current asset balances:`);
    logger.log(`Investor1: ${currentAssetBalanceInvestor1.totalBalance} units, ${currentAssetBalanceInvestor1.totalStates} states, overflow: ${currentAssetBalanceInvestor1.overflow}`);
    logger.log(`Investor2: ${currentAssetBalanceInvestor2.totalBalance} units, ${currentAssetBalanceInvestor2.totalStates} states, overflow: ${currentAssetBalanceInvestor2.overflow}`);

    if (currentAssetBalanceInvestor1.totalBalance !== contractData.finalBalances.asset.investor1.totalBalance) {
      logger.error(`STEP 3: ERROR - Investor1 asset balance does not match saved data!`);
      logger.error(`Expected: ${contractData.finalBalances.asset.investor1.totalBalance}`);
      logger.error(`Found: ${currentAssetBalanceInvestor1.totalBalance}`);
      return false;
    }

    if (currentAssetBalanceInvestor2.totalBalance !== contractData.finalBalances.asset.investor2.totalBalance) {
      logger.error(`STEP 3: ERROR - Investor2 asset balance does not match saved data!`);
      logger.error(`Expected: ${contractData.finalBalances.asset.investor2.totalBalance}`);
      logger.error(`Found: ${currentAssetBalanceInvestor2.totalBalance}`);
      return false;
    }

    logger.log("STEP 3: Asset balance verification successful!");
  } catch (error) {
    logger.error("STEP 3: Failed to retrieve asset balances!");
    logger.error(`Error: ${error}`);
    return false;
  }

  // STEP 4: Verify cash token balances
  logger.log("STEP 4: Verifying cash token balances...");
  try {
    const currentCashBalanceInvestor1 = await notoCash.using(paladin2).balanceOf(investor1, { account: investor1.lookup });
    const currentCashBalanceInvestor2 = await notoCash.using(paladin3).balanceOf(investor2, { account: investor2.lookup });

    logger.log(`STEP 4: Current cash balances:`);
    logger.log(`Investor1: ${currentCashBalanceInvestor1.totalBalance} units, ${currentCashBalanceInvestor1.totalStates} states, overflow: ${currentCashBalanceInvestor1.overflow}`);
    logger.log(`Investor2: ${currentCashBalanceInvestor2.totalBalance} units, ${currentCashBalanceInvestor2.totalStates} states, overflow: ${currentCashBalanceInvestor2.overflow}`);

    if (currentCashBalanceInvestor1.totalBalance !== contractData.finalBalances.cash.investor1.totalBalance) {
      logger.error(`STEP 4: ERROR - Investor1 cash balance does not match saved data!`);
      logger.error(`Expected: ${contractData.finalBalances.cash.investor1.totalBalance}`);
      logger.error(`Found: ${currentCashBalanceInvestor1.totalBalance}`);
      return false;
    }

    if (currentCashBalanceInvestor2.totalBalance !== contractData.finalBalances.cash.investor2.totalBalance) {
      logger.error(`STEP 4: ERROR - Investor2 cash balance does not match saved data!`);
      logger.error(`Expected: ${contractData.finalBalances.cash.investor2.totalBalance}`);
      logger.error(`Found: ${currentCashBalanceInvestor2.totalBalance}`);
      return false;
    }

    logger.log("STEP 4: Cash balance verification successful!");
  } catch (error) {
    logger.error("STEP 4: Failed to retrieve cash balances!");
    logger.error(`Error: ${error}`);
    return false;
  }

  // STEP 5: Verify swap details are preserved
  logger.log("STEP 5: Verifying swap details are preserved...");
  try {
    logger.log(`STEP 5: Swap details verification:`);
    logger.log(`Asset amount: ${contractData.swapDetails.assetAmount}`);
    logger.log(`Cash amount: ${contractData.swapDetails.cashAmount}`);
    logger.log(`Asset lock ID: ${contractData.swapDetails.assetLockId}`);
    logger.log(`Cash lock ID: ${contractData.swapDetails.cashLockId}`);
    logger.log(`Asset unlock call: ${contractData.swapDetails.assetUnlockCall.substring(0, 50)}...`);
    logger.log(`Cash unlock call: ${contractData.swapDetails.cashUnlockCall.substring(0, 50)}...`);

    if (!contractData.swapDetails.assetLockId || !contractData.swapDetails.cashLockId) {
      logger.error("STEP 5: ERROR - Swap details are missing critical information!");
      return false;
    }

    if (!contractData.swapDetails.assetUnlockCall || !contractData.swapDetails.cashUnlockCall) {
      logger.error("STEP 5: ERROR - Swap call data is missing!");
      return false;
    }

    logger.log("STEP 5: Swap details verification successful!");
  } catch (error) {
    logger.error("STEP 5: Swap details verification failed!");
    logger.error(`Error: ${error}`);
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
