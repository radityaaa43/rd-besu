import PaladinClient, {
  PaladinVerifier,
  PentePrivacyGroup,
  PentePrivateContract,
} from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT } from "paladin-example-common";
// Fork of upstream BondSubscription (contracts/src/RestrictedBondSubscription.sol): the atom it
// builds is a RestrictedAtom, so `atomFactory_` must be a RestrictedAtomFactory address.
import bondSubscription from "../abis/RestrictedBondSubscription.json";

const bondSubscriptionConstructor = bondSubscription.abi.find(
  (entry) => entry.type === "constructor"
);

export interface BondSubscriptionConstructorParams {
  bondAddress_: string;
  units_: string | number;
  custodian_: string;
  atomFactory_: string;
}

// lockId / cancelCall come from the same prepareUnlock receipt as encodedCall; the atom uses
// them to release the leg if the sale is cancelled after the lock was delegated to it.
export interface PreparePaymentParams {
  to: string;
  encodedCall: string;
  lockId: string;
  cancelCall: string;
}

export interface PrepareBondParams {
  to: string;
  encodedCall: string;
  lockId: string;
  cancelCall: string;
}

export const newBondSubscription = async (
  pente: PentePrivacyGroup,
  from: PaladinVerifier,
  params: BondSubscriptionConstructorParams
) => {
  if (bondSubscriptionConstructor === undefined) {
    throw new Error("Bond subscription constructor not found");
  }
  const address = await pente
    .deploy({
      abi: bondSubscription.abi,
      bytecode: bondSubscription.bytecode,
      from: from.lookup,
      inputs: params,
    })
    .waitForDeploy(DEFAULT_POLL_TIMEOUT);
  return address ? new BondSubscription(pente, address) : undefined;
};

export class BondSubscription extends PentePrivateContract<BondSubscriptionConstructorParams> {
  constructor(
    protected evm: PentePrivacyGroup,
    public readonly address: string
  ) {
    super(evm, bondSubscription.abi, address);
  }

  using(paladin: PaladinClient) {
    return new BondSubscription(this.evm.using(paladin), this.address);
  }

  preparePayment(from: PaladinVerifier, params: PreparePaymentParams) {
    return this.sendTransaction({
      from: from.lookup,
      function: "preparePayment",
      data: params,
    });
  }

  prepareBond(from: PaladinVerifier, params: PrepareBondParams) {
    return this.sendTransaction({
      from: from.lookup,
      function: "prepareBond",
      data: params,
    });
  }

  distribute(from: PaladinVerifier) {
    return this.sendTransaction({
      from: from.lookup,
      function: "distribute",
    });
  }
}
