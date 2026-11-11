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
  TransactionType,
} from "@lfdecentralizedtrust/paladin-sdk";
import {
  checkDeploy,
  checkReceipt,
  getCachePath,
  DEFAULT_POLL_TIMEOUT,
} from "paladin-example-common";
import atomJson from "./abis/RestrictedAtom.json";
import atomFactoryJson from "./abis/RestrictedAtomFactory.json";
import bondTrackerPublicJson from "./abis/BondTrackerPublic.json";
import { newAtomFactory } from "./helpers/atom";
import { newBondSubscription } from "./helpers/bondsubscription";
import { newBondTracker } from "./helpers/bondtracker";
import { newERC20Tracker } from "./helpers/erc20tracker";
import * as fs from "fs";
import { parseArgs } from "util";
import { waitForBalance } from "./lib/platform";
import * as path from "path";
import { Balance, ContractData, InvestorRecord } from "./tests/data-persistence";
import { nodeConnections } from "paladin-example-common";

const logger = console;

const toBalance = (b: NotoBalanceOfResult): Balance => ({
  totalBalance: b.totalBalance,
  totalStates: b.totalStates,
  overflow: b.overflow,
});

function positiveInt(name: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) === 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${name} must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

async function main(): Promise<boolean> {
  const { values } = parseArgs({
    options: {
      supply: { type: "string", default: "1000" },
      "cash-per-investor": { type: "string", default: "100000" },
      "units-per-investor": { type: "string", default: "100" },
      // Primary price must be an integer: BondTracker.beginDistribution takes uint256 discountPrice.
      price: { type: "string", default: "1" },
      cache: { type: "string" },
    },
  });
  const BOND_SUPPLY = positiveInt("supply", values.supply!);
  const INITIAL_CASH_PER_INVESTOR = positiveInt("cash-per-investor", values["cash-per-investor"]!);
  const BOND_UNITS_PER_INVESTOR = positiveInt("units-per-investor", values["units-per-investor"]!);
  const PRICE = positiveInt("price", values.price!);
  const CASH_PER_INVESTOR = BOND_UNITS_PER_INVESTOR * PRICE;
  if (BOND_UNITS_PER_INVESTOR * 3 > BOND_SUPPLY) {
    logger.error(`--supply ${BOND_SUPPLY} cannot cover 3 investors x ${BOND_UNITS_PER_INVESTOR} units`);
    return false;
  }
  if (CASH_PER_INVESTOR > INITIAL_CASH_PER_INVESTOR) {
    logger.error(`Each investor needs ${CASH_PER_INVESTOR} cash but only receives ${INITIAL_CASH_PER_INVESTOR}`);
    return false;
  }
  logger.log(
    `Issuance: supply=${BOND_SUPPLY}, cash/investor=${INITIAL_CASH_PER_INVESTOR}, ` +
      `units/investor=${BOND_UNITS_PER_INVESTOR}, price=${PRICE}`
  );

  if (nodeConnections.length < 4) {
    logger.error("The environment config must provide 4 nodes for this scenario.");
    return false;
  }

  logger.log("Initializing Paladin clients from the environment configuration...");
  const clients = nodeConnections.map((node) => new PaladinClient(node.clientOptions));
  const paladin1 = clients[0];

  // node1 hosts the issuer and custodian; nodes 2-4 each host one investor
  const [cashIssuer, bondIssuer, bondCustodian] = paladin1.getVerifiers(
    `cashIssuer@${nodeConnections[0].id}`,
    `bondIssuer@${nodeConnections[0].id}`,
    `bondCustodian@${nodeConnections[0].id}`
  );
  const investors = [1, 2, 3].map((i) => ({
    name: `investor${i}`,
    node: nodeConnections[i].id,
    client: clients[i],
    verifier: clients[i].getVerifiers(`investor${i}@${nodeConnections[i].id}`)[0],
  }));

  const notoFactory = new NotoFactory(paladin1, "noto");
  const penteFactory = new PenteFactory(paladin1, "pente");

  // --- Cash: Noto (hooks) backed by its own Pente group + ERC20 tracker ---
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

  for (const inv of investors) {
    logger.log(`Issuing ${INITIAL_CASH_PER_INVESTOR} cash to ${inv.name}@${inv.node}...`);
    const receipt = await notoCash
      .mint(cashIssuer, { to: inv.verifier, amount: INITIAL_CASH_PER_INVESTOR, data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;
  }

  // --- Bond: Noto (hooks) backed by the issuer+custodian Pente group + BondTracker ---
  logger.log("Creating issuer+custodian privacy group...");
  const issuerCustodianGroup = await penteFactory
    .newPrivacyGroup({
      members: [bondIssuer, bondCustodian],
      evmVersion: "shanghai",
      externalCallsEnabled: true,
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(issuerCustodianGroup)) return false;

  logger.log("Creating public bond tracker...");
  const issueDate = Math.floor(Date.now() / 1000);
  const maturityDate = issueDate + 60 * 60 * 24;
  let txID = await paladin1.ptx.sendTransaction({
    type: TransactionType.PUBLIC,
    abi: bondTrackerPublicJson.abi,
    bytecode: bondTrackerPublicJson.bytecode,
    function: "",
    from: bondIssuer.lookup,
    data: {
      owner: issuerCustodianGroup.address,
      issueDate_: issueDate,
      maturityDate_: maturityDate,
      currencyToken_: notoCash.address,
      faceValue_: 1,
    },
  });
  let receipt = await paladin1.pollForReceipt(txID, DEFAULT_POLL_TIMEOUT);
  if (receipt?.contractAddress === undefined) {
    logger.error("Failed!");
    return false;
  }
  const bondTrackerPublicAddress = receipt.contractAddress;
  logger.log(`Success! address: ${bondTrackerPublicAddress}`);

  logger.log("Creating private bond tracker...");
  const bondTracker = await newBondTracker(issuerCustodianGroup, bondIssuer, {
    name: "BOND",
    symbol: "BOND",
    custodian: await bondCustodian.address(),
    publicTracker: bondTrackerPublicAddress,
  });
  if (!checkDeploy(bondTracker)) return false;

  logger.log("Deploying Noto bond token...");
  const notoBond = await notoFactory
    .newNoto(bondIssuer, {
      name: "BOND",
      symbol: "BOND",
      notary: bondCustodian,
      notaryMode: "hooks",
      options: {
        hooks: {
          privateGroup: issuerCustodianGroup,
          publicAddress: issuerCustodianGroup.address,
          privateAddress: bondTracker.address,
        },
      },
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  if (!checkDeploy(notoBond)) return false;

  logger.log("Creating restricted atom factory (issuance and platform trades)...");
  const restrictedAtomFactory = await newAtomFactory(paladin1, bondIssuer);
  if (restrictedAtomFactory === undefined) {
    logger.error("Failed!");
    return false;
  }
  const restrictedAtomFactoryAddress = restrictedAtomFactory.address;
  logger.log(`Success! address: ${restrictedAtomFactoryAddress}`);

  logger.log(`Issuing ${BOND_SUPPLY} bond to custodian...`);
  receipt = await notoBond
    .mint(bondIssuer, { to: bondCustodian, amount: BOND_SUPPLY, data: "0x" })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;

  logger.log("Beginning distribution...");
  receipt = await bondTracker
    .beginDistribution(bondCustodian, { discountPrice: PRICE, minimumDenomination: 1 })
    .waitForReceipt(DEFAULT_POLL_TIMEOUT);
  if (!checkReceipt(receipt)) return false;

  const investorList = await bondTracker.investorList(bondIssuer);
  for (const inv of investors) {
    logger.log(`Registering ${inv.name} as allowed investor...`);
    receipt = await investorList
      .addInvestor(bondCustodian, { addr: await inv.verifier.address() })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;
  }

  // --- One atomic bond purchase per investor ---
  const records: InvestorRecord[] = [];
  for (const [idx, inv] of investors.entries()) {
    const investor = inv.verifier;
    const invClient = inv.client;
    logger.log(`\n=== Purchase ${idx + 1}/${investors.length}: ${inv.name}@${inv.node} ===`);

    logger.log("Creating investor+custodian privacy group...");
    const investorCustodianGroup = await penteFactory
      .using(invClient)
      .newPrivacyGroup({
        members: [investor, bondCustodian],
        evmVersion: "shanghai",
        externalCallsEnabled: true,
      })
      .waitForDeploy(DEFAULT_POLL_TIMEOUT);
    if (!checkDeploy(investorCustodianGroup)) return false;

    logger.log("Creating private bond subscription...");
    const bondSubscription = await newBondSubscription(investorCustodianGroup, investor, {
      bondAddress_: notoBond.address,
      units_: BOND_UNITS_PER_INVESTOR,
      custodian_: await bondCustodian.address(),
      atomFactory_: restrictedAtomFactoryAddress,
    });
    if (!checkDeploy(bondSubscription)) return false;

    logger.log("Locking cash from investor...");
    receipt = await notoCash
      .using(invClient)
      .lock(investor, { amount: CASH_PER_INVESTOR, data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!checkReceipt(receipt)) return false;
    let domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
    const cashLockId = domainReceipt?.lockInfo?.lockId;
    if (cashLockId === undefined) {
      logger.error("No cash lock ID found in domain receipt");
      return false;
    }

    logger.log("Preparing cash unlock to custodian...");
    receipt = await notoCash
      .using(invClient)
      .prepareUnlock(investor, {
        lockId: cashLockId,
        from: investor,
        recipients: [{ to: bondCustodian, amount: CASH_PER_INVESTOR }],
        unlockData: "0x",
        data: "0x",
      })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!checkReceipt(receipt)) return false;
    domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
    const cashUnlockCall = domainReceipt?.lockInfo?.unlockCall;
    const cashCancelCall = domainReceipt?.lockInfo?.cancelCall;
    if (cashUnlockCall === undefined || cashCancelCall === undefined) {
      logger.error("No cash unlock/cancel data found in domain receipt");
      return false;
    }

    logger.log("Locking bond from custodian...");
    receipt = await notoBond
      .lock(bondCustodian, { amount: BOND_UNITS_PER_INVESTOR, data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!checkReceipt(receipt)) return false;
    domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
    const bondLockId = domainReceipt?.lockInfo?.lockId;
    if (bondLockId === undefined) {
      logger.error("No bond lock ID found in domain receipt");
      return false;
    }

    logger.log("Preparing bond unlock to investor...");
    receipt = await notoBond
      .prepareUnlock(bondCustodian, {
        lockId: bondLockId,
        from: bondCustodian,
        recipients: [{ to: investor, amount: BOND_UNITS_PER_INVESTOR }],
        unlockData: "0x",
        data: "0x",
      })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT, true);
    if (!checkReceipt(receipt)) return false;
    domainReceipt = receipt?.domainReceipt as INotoDomainReceipt | undefined;
    const bondUnlockCall = domainReceipt?.lockInfo?.unlockCall;
    const bondCancelCall = domainReceipt?.lockInfo?.cancelCall;
    if (bondUnlockCall === undefined || bondCancelCall === undefined) {
      logger.error("No bond unlock/cancel data found in domain receipt");
      return false;
    }

    logger.log("Adding payment to subscription request...");
    receipt = await bondSubscription
      .using(invClient)
      .preparePayment(investor, {
        to: notoCash.address,
        encodedCall: cashUnlockCall,
        lockId: cashLockId,
        cancelCall: cashCancelCall,
      })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;

    logger.log("Adding bond to subscription request...");
    receipt = await bondSubscription
      .using(paladin1)
      .prepareBond(bondCustodian, {
        to: notoBond.address,
        encodedCall: bondUnlockCall,
        lockId: bondLockId,
        cancelCall: bondCancelCall,
      })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;

    logger.log("Generating atom for bond distribution...");
    receipt = await bondSubscription
      .using(paladin1)
      .distribute(bondCustodian)
      .waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;
    const events = await paladin1.bidx.decodeTransactionEvents(
      receipt.transactionHash,
      atomFactoryJson.abi,
      ""
    );
    const atomDeployedEvent = events.find(
      (e) => e.soliditySignature === "event AtomDeployed(address addr)"
    );
    if (atomDeployedEvent === undefined) {
      logger.error("Did not find AtomDeployed event");
      return false;
    }
    const atomAddress = atomDeployedEvent.data.addr;
    logger.log(`Success! atom: ${atomAddress}`);

    logger.log("Approving payment transfer...");
    receipt = await notoCash
      .using(invClient)
      .delegateLock(investor, { lockId: cashLockId, delegate: atomAddress, data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;

    logger.log("Approving bond transfer...");
    receipt = await notoBond
      .delegateLock(bondCustodian, { lockId: bondLockId, delegate: atomAddress, data: "0x" })
      .waitForReceipt(DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;

    logger.log("Executing atomic distribution...");
    txID = await paladin1.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: atomJson.abi,
      function: "execute",
      from: bondCustodian.lookup,
      to: atomAddress,
      data: {},
    });
    receipt = await paladin1.pollForReceipt(txID, DEFAULT_POLL_TIMEOUT);
    if (!checkReceipt(receipt)) return false;

    const finalBond = await waitForBalance(
      `${inv.name} bond`,
      () => notoBond.using(invClient).balanceOf(investor, { account: investor.lookup }),
      BOND_UNITS_PER_INVESTOR,
      "exact"
    );
    const finalCash = await waitForBalance(
      `${inv.name} cash`,
      () => notoCash.using(invClient).balanceOf(investor, { account: investor.lookup }),
      INITIAL_CASH_PER_INVESTOR - CASH_PER_INVESTOR,
      "exact"
    );
    if (!finalBond || !finalCash) return false;
    logger.log(`${inv.name}: ${finalBond.totalBalance} bond, ${finalCash.totalBalance} cash`);

    records.push({
      name: inv.name,
      node: inv.node,
      lookup: investor.lookup,
      investorCustodianGroupId: investorCustodianGroup.group.id,
      investorCustodianGroupAddress: investorCustodianGroup.address,
      bondSubscriptionAddress: bondSubscription.address,
      atomAddress,
      cashLockId,
      bondLockId,
      cashUnlockCall,
      bondUnlockCall,
      finalBalances: { cash: toBalance(finalCash), bond: toBalance(finalBond) },
    });
  }

  const custodianBond = await waitForBalance(
    "custodian bond",
    () => notoBond.balanceOf(bondCustodian, { account: bondCustodian.lookup }),
    BOND_SUPPLY - BOND_UNITS_PER_INVESTOR * investors.length,
    "exact"
  );
  const custodianCash = await waitForBalance(
    "custodian cash",
    () => notoCash.balanceOf(bondCustodian, { account: bondCustodian.lookup }),
    CASH_PER_INVESTOR * investors.length,
    "exact"
  );
  if (!custodianBond || !custodianCash) return false;
  logger.log(`\nCustodian: ${custodianBond.totalBalance} bond, ${custodianCash.totalBalance} cash`);

  const contractData: ContractData = {
    notoCashAddress: notoCash.address,
    notoBondAddress: notoBond.address,
    cashGroupId: cashGroup.group.id,
    cashGroupAddress: cashGroup.address,
    cashTrackerAddress: cashTracker.address,
    issuerCustodianGroupId: issuerCustodianGroup.group.id,
    issuerCustodianGroupAddress: issuerCustodianGroup.address,
    bondTrackerAddress: bondTracker.address,
    bondTrackerPublicAddress,
    restrictedAtomFactoryAddress,
    bondDetails: {
      issueDate,
      maturityDate,
      faceValue: 1,
      discountPrice: PRICE,
      minimumDenomination: 1,
      bondSupply: BOND_SUPPLY,
      bondUnitsPerInvestor: BOND_UNITS_PER_INVESTOR,
      cashPerInvestor: CASH_PER_INVESTOR,
      initialCashPerInvestor: INITIAL_CASH_PER_INVESTOR,
    },
    investors: records,
    custodianFinalBalances: {
      cash: toBalance(custodianCash),
      bond: toBalance(custodianBond),
    },
    participants: {
      cashIssuer: cashIssuer.lookup,
      bondIssuer: bondIssuer.lookup,
      bondCustodian: bondCustodian.lookup,
    },
    timestamp: new Date().toISOString(),
  };

  const dataDir = getCachePath();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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
