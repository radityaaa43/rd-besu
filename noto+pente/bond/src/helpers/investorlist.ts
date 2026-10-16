import PaladinClient, {
  PaladinVerifier,
  PentePrivacyGroup,
  PentePrivateContract,
} from "@lfdecentralizedtrust/paladin-sdk";
import investorList from "../abis/InvestorList.json";

export interface AddInvestorParams {
  addr: string;
}

export class InvestorList extends PentePrivateContract<{}> {
  constructor(
    protected evm: PentePrivacyGroup,
    public readonly address: string
  ) {
    super(evm, investorList.abi, address);
  }

  using(paladin: PaladinClient) {
    return new InvestorList(this.evm.using(paladin), this.address);
  }

  addInvestor(from: PaladinVerifier, params: AddInvestorParams) {
    return this.sendTransaction({
      from: from.lookup,
      function: "addInvestor",
      data: params,
    });
  }

  async isRegistered(from: PaladinVerifier, addr: string): Promise<boolean> {
    const result = await this.call({
      from: from.lookup,
      function: "isRegistered",
      data: { addr },
    });
    return result[0] === true || result[0] === "true";
  }
}
