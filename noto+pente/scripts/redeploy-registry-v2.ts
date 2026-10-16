/*
 * Task #11: redeploy ONLY BondSeriesRegistry as v2 (adds `publicTracker` to registerSeries/
 * Series/getSeries -- see the contract's own doc comment). Exactly 1 transaction, from
 * bondCustodian@node1 (the same owner as the original v1 deploy). Does NOT touch the cash
 * token, RestrictedAtomFactory, or any investor+custodian group from the original bootstrap --
 * those stay exactly as they are. The old v1 registry and the test series registered on it
 * (0x26581f7e...) are simply orphaned, never referenced again.
 *
 * Prints the new registry address and the tx hash on success. Run manually, once, with the
 * cluster's port-forward already up.
 *
 * Run: NODE_PATH=../bond/node_modules:../swap-noto/node_modules ../bond/node_modules/.bin/ts-node redeploy-registry-v2.ts
 */
import PaladinClientSdk, { TransactionType } from "@lfdecentralizedtrust/paladin-sdk";
import { DEFAULT_POLL_TIMEOUT, nodeConnections } from "paladin-example-common";
import bondSeriesRegistryArtifact from "../common/paladin-client/src/abis/BondSeriesRegistry.json";

const logger = console;
const BI_LOOKUP = "bondCustodian@node1";

async function main(): Promise<boolean> {
  const node1 = new PaladinClientSdk(nodeConnections[0].clientOptions);
  const [biVerifier] = node1.getVerifiers(BI_LOOKUP);
  const biAddress = await biVerifier.address();
  logger.log(`Deploying BondSeriesRegistry v2, owner=${BI_LOOKUP} (${biAddress})...`);

  const txId = await node1.ptx.sendTransaction({
    type: TransactionType.PUBLIC,
    abi: bondSeriesRegistryArtifact.abi,
    bytecode: (bondSeriesRegistryArtifact as any).bytecode.object,
    function: "",
    from: biVerifier.lookup,
    data: { owner_: biAddress },
  });
  const receipt = await node1.pollForReceipt(txId, DEFAULT_POLL_TIMEOUT);
  if (!receipt?.success || !receipt.contractAddress) {
    logger.error(`Deploy failed: ${JSON.stringify(receipt)}`);
    return false;
  }
  logger.log(`registryAddress=${receipt.contractAddress}`);
  logger.log(`txHash=${receipt.transactionHash}`);
  return true;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
