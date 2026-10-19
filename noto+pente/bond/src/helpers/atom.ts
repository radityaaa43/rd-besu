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
  PaladinVerifier,
  TransactionType,
} from "@lfdecentralizedtrust/paladin-sdk";
import atomJson from "../abis/RestrictedAtom.json";
import atomFactoryJson from "../abis/RestrictedAtomFactory.json";
import { DEFAULT_POLL_TIMEOUT } from "paladin-example-common";

// Platform trades use this repo's RestrictedAtom (contracts/src/RestrictedAtom.sol), not
// upstream's Atom: upstream's cancel()/execute() have no access control, so any account could
// cancel a delegated trade mid-flight. Flow order is the same as upstream's
// (lock, prepareUnlock, create atom, delegateLock, execute).
export interface AtomOperation {
  contractAddress: string;
  callData: string;
}

// Per-leg release the atom runs if it is cancelled after that leg's lock was delegated to it.
export interface AtomCancelOperation extends AtomOperation {
  lockId: string;
}

export const newAtomFactory = async (
  paladin: PaladinClient,
  from: PaladinVerifier
) => {
  const txID = await paladin.ptx.sendTransaction({
    type: TransactionType.PUBLIC,
    abi: atomFactoryJson.abi,
    bytecode: atomFactoryJson.bytecode,
    function: "",
    from: from.lookup,
    data: {},
  });
  const receipt = await paladin.pollForReceipt(txID, DEFAULT_POLL_TIMEOUT);
  return receipt?.contractAddress
    ? new AtomFactory(paladin, receipt.contractAddress)
    : undefined;
};

export class AtomFactory {
  constructor(
    protected paladin: PaladinClient,
    public readonly address: string
  ) {}

  using(paladin: PaladinClient) {
    return new AtomFactory(paladin, this.address);
  }

  // `parties` (the accounts whose legs are in the atom) and `executor` (BI) are the only
  // addresses allowed to cancel / execute the atom.
  async create(
    from: PaladinVerifier,
    operations: AtomOperation[],
    cancelOperations: AtomCancelOperation[],
    parties: string[],
    executor: string
  ) {
    const txID = await this.paladin.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: atomFactoryJson.abi,
      function: "create",
      from: from.lookup,
      to: this.address,
      data: { operations, cancelOperations, parties, executor },
    });
    const receipt = await this.paladin.pollForReceipt(txID, DEFAULT_POLL_TIMEOUT);
    if (receipt) {
      const events = await this.paladin.bidx.decodeTransactionEvents(
        receipt.transactionHash,
        atomFactoryJson.abi,
        ""
      );
      const deployedEvent = events.find((ev: any) =>
        ev.soliditySignature.startsWith("event AtomDeployed")
      );
      const atomAddress = deployedEvent?.data.addr;
      return atomAddress ? new Atom(this.paladin, atomAddress) : undefined;
    }
    return undefined;
  }
}

export class Atom {
  constructor(
    protected paladin: PaladinClient,
    public readonly address: string
  ) {}

  using(paladin: PaladinClient) {
    return new Atom(paladin, this.address);
  }

  async execute(from: PaladinVerifier) {
    return this.call("execute", from);
  }

  async cancel(from: PaladinVerifier) {
    return this.call("cancel", from);
  }

  private async call(fn: "execute" | "cancel", from: PaladinVerifier) {
    const txID = await this.paladin.ptx.sendTransaction({
      type: TransactionType.PUBLIC,
      abi: atomJson.abi,
      function: fn,
      from: from.lookup,
      to: this.address,
      data: {},
    });
    return this.paladin.pollForReceipt(txID, DEFAULT_POLL_TIMEOUT);
  }
}
