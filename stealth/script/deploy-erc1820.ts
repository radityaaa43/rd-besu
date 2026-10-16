// Deploys the ERC1820 registry via its standard pre-signed transaction (EIP-1820), not a normal deploy.
// Usage: set -a && . ./.env.smoke && set +a && node script/deploy-erc1820.ts [runtime-fixture-output-path]
import { readFileSync, writeFileSync } from 'node:fs';
import { getCreateAddress, JsonRpcProvider, Transaction, Wallet } from 'ethers';

const SENDER = '0xa990077c3205cbDf861e17Fa532eeB069cE9fF96';
const REGISTRY = '0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

// cacheTimeout -1: no request caching, so getCode after the deploy is fresh.
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
const funder = new Wallet(DEPLOYER_KEY, provider);

const raw = readFileSync(new URL('./erc1820-deploy-tx.hex', import.meta.url), 'utf8').trim();
const tx = Transaction.from(raw);
// The raw transaction is untrusted until sender and resulting contract address check out.
if (tx.from !== SENDER || tx.nonce !== 0) {
  throw new Error('pre-signed tx is not the EIP-1820 deployment');
}
if (getCreateAddress({ from: tx.from, nonce: tx.nonce }) !== REGISTRY) {
  throw new Error('pre-signed tx does not create the expected registry address');
}

console.log('chainId', (await provider.getNetwork()).chainId.toString());
if ((await provider.getCode(REGISTRY)) === '0x') {
  // The pre-signed tx has a fixed gas price (100 gwei), so the sender needs gasPrice * gasLimit up front,
  // even on a network with its own gas price 0.
  const cost = tx.gasPrice! * tx.gasLimit;
  const have = await provider.getBalance(SENDER);
  if (have < cost) await (await funder.sendTransaction({ to: SENDER, value: cost - have })).wait();
  await (await provider.broadcastTransaction(raw)).wait();
}
const code = await provider.getCode(REGISTRY);
if (code === '0x') throw new Error('registry code missing after deployment');
console.log('ERC1820 registry at', REGISTRY, '|', (code.length - 2) / 2, 'bytes');
if (process.argv[2]) writeFileSync(process.argv[2], code); // no trailing newline: vm.parseBytes rejects one
process.exit(0);
