// One-off smoke check against a live Besu network. Not part of CI.
// Usage: forge build && RPC_URL=... DEPLOYER_KEY=0x... node script/smoke.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from '../ts/stealth.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

const provider = new JsonRpcProvider(RPC_URL);
const deployer = new Wallet(DEPLOYER_KEY, provider);

async function deploy(name: string): Promise<Contract> {
  const { abi, bytecode } = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  const c = await new ContractFactory(abi, bytecode.object, deployer).deploy();
  await c.waitForDeployment();
  return c as unknown as Contract;
}

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());

// Besu caps the eth_getLogs range ("Requested range exceeds maximum RPC range limit"), so scan from here, not block 0.
const fromBlock = await provider.getBlockNumber();
const announcer = await deploy('ERC5564Announcer');
const registry = await deploy('ERC6538Registry');
console.log('announcer', await announcer.getAddress(), '| registry', await registry.getAddress());

// Recipient registers a meta-address.
const me = generateMetaAddress();
await (await registry.registerKeys(1, me.metaAddress)).wait();

// Sender reads it from the registry, derives a stealth address, announces.
const s = deriveStealth(await registry.stealthMetaAddressOf(deployer.address, 1));
await (await announcer.announce(1, s.stealthAddress, s.ephemeralPubKey, s.viewTag)).wait();

// Recipient scans the chain logs.
const logs = await announcer.queryFilter(announcer.filters.Announcement(), fromBlock);
const anns: Announcement[] = logs.map((l: any) => ({
  schemeId: l.args.schemeId,
  stealthAddress: l.args.stealthAddress,
  ephemeralPubKey: l.args.ephemeralPubKey,
  metadata: l.args.metadata,
}));
const [found] = scan(anns, me.viewKey, me.spendKey);
if (!found || found.stealthAddress !== s.stealthAddress) throw new Error('scan did not recover the stealth address');

// Spend: a fresh stealth address holds no gas. Fund it only if gas is not free.
const stealth = new Wallet(found.privateKey, provider);
const gasLimit = 21000n;
if (gasPrice > 0n) {
  await (await deployer.sendTransaction({ to: stealth.address, value: gasPrice * gasLimit * 2n, gasPrice, gasLimit })).wait();
}
const rc = await (await stealth.sendTransaction({ to: deployer.address, value: 0n, gasPrice, gasLimit })).wait();
if (rc?.from !== stealth.address) throw new Error('tx was not signed by the stealth key');
console.log('OK: scan recovered', stealth.address, '| tx signed by stealth key', rc.hash);
