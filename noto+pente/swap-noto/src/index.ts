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
  INotoDomainReceipt,
  NotoBalanceOfResult,
  NotoFactory,
  PenteFactory,
} from "@lfdecentralizedtrust/paladin-sdk";
import {
  checkDeploy,
  checkReceipt,
  DEFAULT_POLL_TIMEOUT,
  LONG_POLL_TIMEOUT,
  POLL_INTERVAL,
} from "paladin-example-common";
import { newAtomFactory } from "./helpers/atom";
import { newERC20Tracker } from "./helpers/erc20tracker";
import * as fs from 'fs';
import * as path from 'path';
import { ContractData } from "./tests/data-persistence";
import { nodeConnections, getCachePath } from "paladin-example-common";

const logger = console;

async function main(): Promise<boolean> {
  // --- Initialization from Imported Config ---
  if (nodeConnections.length < 4) {
    logger.error("The environment config must provide at least 4 nodes for this scenario.");
    return false;
  }

  logger.log("Initializing Paladin clients from the environment configuration...");
  const clients = nodeConnections.map(node => new PaladinClient(node.clientOptions));
  // Non-contiguous mapping: node2 (index 1) has no role in this flow.
  const paladin1 = clients[0]; // node1: cashIssuer + assetIssuer
  const paladin2 = clients[2]; // node3: investor1
  const paladin3 = clients[3]; // node4: investor2

  const [cashIssuer, assetIssuer] = paladin1.getVerifiers(
    `cashIssuer@${nodeConnections[0].id}`,
    `assetIssuer@${nodeConnections[0].id}`
  );
  const [investor1] = paladin2.getVerifiers(`investor1@${nodeConnections[2].id}`);
  const [investor2] = paladin3.getVerifiers(`investor2@${nodeConnections[3].id}`);

  const issuedAssetAmount = 1000;
  const issuedCashAmount = 10000;
  const assetAmount = 100;
  const cashAmount = 10;

  // Deploy the atom factory on the base ledger
  logger.log("Creating atom factory...");
  const atomFactory = await newAtomFactory(paladin1, cashIssuer);
  if (!checkDeploy(atomFactory)) return false;

  const notoFactory = new NotoFactory(paladin1, "noto");
  const penteFactory = new PenteFactory(paladin1, "pente");

  // --- Asset leg: Noto (hooks) backed by its own Pente group + tracker ---
  logger.log("Creating asset issuer privacy group...");
  const assetGroup = await penteFactory
    .newPrivacyGroup({
      members: [assetIssuer],
      evmVersion: "shanghai",
      externalCallsEnabled: true,
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(assetGroup)) return false;

  logger.log("Creating private asset tracker...");
  const assetTracker = await newERC20Tracker(assetGroup, assetIssuer, {
    name: "ASSET",
    symbol: "ASSET",
  });
  if (!checkDeploy(assetTracker)) return false;

  logger.log("Deploying Noto asset token...");
  const notoAsset = await notoFactory
    .newNoto(assetIssuer, {
      name: "NOTO",
      symbol: "NOTO",
      notary: assetIssuer,
      notaryMode: "hooks",
      options: {
        hooks: {
          privateGroup: assetGroup,
          publicAddress: assetGroup.address,
          privateAddress: assetTracker.address,
        },
      },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(notoAsset)) return false;

  // --- Cash leg: Noto (hooks) backed by its own Pente group + tracker ---
  logger.log("Creating cash issuer privacy group...");
  const cashGroup = await penteFactory
    .newPrivacyGroup({
      members: [cashIssuer],
      evmVersion: "shanghai",
      externalCallsEnabled: true,
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(cashGroup)) return false;

  logger.log("Creating private cash tracker...");
  const cashTracker = await newERC20Tracker(cashGroup, cashIssuer, {
    name: "CASH",
    symbol: "CASH",
  });
  if (!checkDeploy(cashTracker)) return false;

  logger.log("Deploying Noto cash token...");
  const notoCash = await notoFactory
    .newNoto(cashIssuer, {
      name: "CASH",
      symbol: "CASH",
      notary: cashIssuer,
      notaryMode: "hooks",
      options: {
        hooks: {
          privateGroup: cashGroup,
          publicAddress: cashGroup.address,
          privateAddress: cashTracker.address,
        },
      },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(notoCash)) return false;

  // Issue asset to investor1, cash to investor2
  logger.log("Issuing asset to investor1...");
  let receipt = await notoAsset
    .mint(assetIssuer, { to: investor1, amount: issuedAssetAmount, data: "0x" })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;

  logger.log("Issuing cash to investor2...");
  receipt = await notoCash
    .mint(cashIssuer, { to: investor2, amount: issuedCashAmount, data: "0x" })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;

  // Lock the asset for the swap
  logger.log("Locking asset from investor1...");
  receipt = await notoAsset
    .using(paladin2)
    .lock(investor1, { amount: assetAmount, data: "0x" })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;
  receipt = await paladin2.ptx.getTransactionReceiptFull(receipt.id);

  let domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
  const assetLockId = domainReceipt?.lockInfo?.lockId;
  if (assetLockId === undefined) {
    logger.error("No lock ID found in asset domain receipt");
    return false;
  }

  // Prepare asset unlock operation
  logger.log("Preparing asset unlock to investor2...");
  receipt = await notoAsset
    .using(paladin2)
    .prepareUnlock(investor1, {
      lockId: assetLockId,
      from: investor1,
      recipients: [{ to: investor2, amount: assetAmount }],
      unlockData: "0x",
      data: "0x",
    })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;
  receipt = await paladin2.ptx.getTransactionReceiptFull(receipt.id);

  domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
  const assetUnlockCall = domainReceipt?.lockInfo?.unlockCall;
  if (assetUnlockCall === undefined) {
    logger.error("No unlock data found in asset domain receipt");
    return false;
  }

  // Lock the cash for the swap
  logger.log("Locking cash from investor2...");
  receipt = await notoCash
    .using(paladin3)
    .lock(investor2, { amount: cashAmount, data: "0x" })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;
  receipt = await paladin3.ptx.getTransactionReceiptFull(receipt.id);

  domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
  const cashLockId = domainReceipt?.lockInfo?.lockId;
  if (cashLockId === undefined) {
    logger.error("No lock ID found in cash domain receipt");
    return false;
  }

  // Prepare cash unlock operation
  logger.log("Preparing cash unlock to investor1...");
  receipt = await notoCash
    .using(paladin3)
    .prepareUnlock(investor2, {
      lockId: cashLockId,
      from: investor2,
      recipients: [{ to: investor1, amount: cashAmount }],
      unlockData: "0x",
      data: "0x",
    })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;
  receipt = await paladin3.ptx.getTransactionReceiptFull(receipt.id);

  domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
  const cashUnlockCall = domainReceipt?.lockInfo?.unlockCall;
  if (cashUnlockCall === undefined) {
    logger.error("No unlock data found in cash domain receipt");
    return false;
  }

  // Create an atom combining both unlock calls
  logger.log("Creating atom...");
  const atom = await atomFactory.create(cashIssuer, [
    { contractAddress: notoAsset.address, callData: assetUnlockCall },
    { contractAddress: notoCash.address, callData: cashUnlockCall },
  ]);
  if (!checkDeploy(atom)) return false;
  logger.log(`Atom created successfully at address: ${atom.address}`);

  // Approve asset unlock operation
  logger.log("Approving asset leg...");
  receipt = await notoAsset
    .using(paladin2)
    .delegateLock(investor1, { lockId: assetLockId, delegate: atom.address, data: "0x" })
    .waitForReceipt(LONG_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;

  // Approve cash unlock operation
  logger.log("Approving cash leg...");
  receipt = await notoCash
    .using(paladin3)
    .delegateLock(investor2, { lockId: cashLockId, delegate: atom.address, data: "0x" })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;

  // Execute the swap
  logger.log("Performing swap...");
  receipt = await atom.using(paladin3).execute(investor2);
  if (!checkReceipt(receipt)) return false;

  // Add a delay to ensure the swap operation is fully settled
  await new Promise((resolve) => setTimeout(resolve, 3000));

  let finalAssetBalanceInvestor1: NotoBalanceOfResult | undefined;
  let finalAssetBalanceInvestor2: NotoBalanceOfResult | undefined;
  let finalCashBalanceInvestor1: NotoBalanceOfResult | undefined;
  let finalCashBalanceInvestor2: NotoBalanceOfResult | undefined;

  // get final balances
  // it can take some time for the balances to update, so loop until all balances are >0
  const startTime = Date.now();
  logger.log("Waiting for balances to settle after swap...");
  while (true) {
    finalAssetBalanceInvestor1 = await notoAsset.using(paladin2).balanceOf(investor1, { account: investor1.lookup });
    finalAssetBalanceInvestor2 = await notoAsset.using(paladin3).balanceOf(investor2, { account: investor2.lookup });
    finalCashBalanceInvestor1 = await notoCash.using(paladin2).balanceOf(investor1, { account: investor1.lookup });
    finalCashBalanceInvestor2 = await notoCash.using(paladin3).balanceOf(investor2, { account: investor2.lookup });

    logger.log(`Current balances - Asset: I1=${finalAssetBalanceInvestor1.totalBalance}, I2=${finalAssetBalanceInvestor2.totalBalance}, Cash: I1=${finalCashBalanceInvestor1.totalBalance}, I2=${finalCashBalanceInvestor2.totalBalance}`);

    if (
      finalAssetBalanceInvestor1.totalBalance !== "0" &&
      finalAssetBalanceInvestor2.totalBalance !== "0" &&
      finalCashBalanceInvestor1.totalBalance !== "0" &&
      finalCashBalanceInvestor2.totalBalance !== "0"
    ) {
      logger.log("All balances are non-zero, proceeding...");
      break;
    }
    if (Date.now() - startTime > LONG_POLL_TIMEOUT) {
      logger.error(`Failed to get final balances after ${LONG_POLL_TIMEOUT / 1000} seconds`);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }

  // Save contract data to file for later use
  const contractData: ContractData = {
    atomFactoryAddress: atomFactory.address,
    notoCashAddress: notoCash.address,
    notoAssetAddress: notoAsset.address,
    assetGroupId: assetGroup.group.id,
    assetGroupAddress: assetGroup.address,
    assetTrackerAddress: assetTracker.address,
    cashGroupId: cashGroup.group.id,
    cashGroupAddress: cashGroup.address,
    cashTrackerAddress: cashTracker.address,
    atomAddress: atom.address,
    swapDetails: {
      assetAmount,
      cashAmount,
      assetLockId,
      cashLockId,
      assetUnlockCall,
      cashUnlockCall,
    },
    finalBalances: {
      asset: {
        investor1: {
          totalBalance: finalAssetBalanceInvestor1?.totalBalance ?? "0",
          totalStates: finalAssetBalanceInvestor1?.totalStates ?? "0",
          overflow: finalAssetBalanceInvestor1?.overflow ?? false,
        },
        investor2: {
          totalBalance: finalAssetBalanceInvestor2?.totalBalance ?? "0",
          totalStates: finalAssetBalanceInvestor2?.totalStates ?? "0",
          overflow: finalAssetBalanceInvestor2?.overflow ?? false,
        },
      },
      cash: {
        investor1: {
          totalBalance: finalCashBalanceInvestor1?.totalBalance ?? "0",
          totalStates: finalCashBalanceInvestor1?.totalStates ?? "0",
          overflow: finalCashBalanceInvestor1?.overflow ?? false,
        },
        investor2: {
          totalBalance: finalCashBalanceInvestor2?.totalBalance ?? "0",
          totalStates: finalCashBalanceInvestor2?.totalStates ?? "0",
          overflow: finalCashBalanceInvestor2?.overflow ?? false,
        },
      },
    },
    participants: {
      cashIssuer: cashIssuer.lookup,
      assetIssuer: assetIssuer.lookup,
      investor1: investor1.lookup,
      investor2: investor2.lookup,
    },
    timestamp: new Date().toISOString(),
  };

  const dataDir = getCachePath();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dataFile = path.join(dataDir, `contract-data-${timestamp}.json`);
  fs.writeFileSync(dataFile, JSON.stringify(contractData, null, 2));
  logger.log(`Contract data saved to ${dataFile}`);

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
