// One-off RD smoke check against a live Besu network. Not part of CI.
// Usage: forge build && set -a && . ./.env.smoke && set +a && node script/smoke-rd.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from '../ts/stealth.ts';
import { buildTokenMetadata, parseTokenMetadata } from '../ts/token.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

const provider = new JsonRpcProvider(RPC_URL);
const issuer = new Wallet(DEPLOYER_KEY, provider);

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('FAILED: ' + msg);
}

async function deploy(name: string, ...args: unknown[]): Promise<Contract> {
  const { abi, bytecode } = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  const c = await new ContractFactory(abi, bytecode.object, issuer).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());

// Besu caps the eth_getLogs range, so read from the block before the deploy.
const fromBlock = await provider.getBlockNumber();
const announcer = await deploy('ERC5564Announcer');
const token = await deploy('RupiahDigital', issuer.address, await announcer.getAddress());
const tokenAddr = await token.getAddress();
console.log('announcer', await announcer.getAddress(), '| rd', tokenAddr);

// tokenFilter=true reads only announcements the token itself emitted (caller == token).
async function announcements(tokenFilter: boolean): Promise<Announcement[]> {
  const f = announcer.filters.Announcement(null, null, tokenFilter ? tokenAddr : null);
  const logs = await announcer.queryFilter(f, fromBlock);
  return logs.map((l: any) => ({
    schemeId: l.args.schemeId,
    stealthAddress: l.args.stealthAddress,
    ephemeralPubKey: l.args.ephemeralPubKey,
    metadata: l.args.metadata,
  }));
}

const bankA = generateMetaAddress();
const bankB = generateMetaAddress();

// 1. BI funds bank A with 1000 RD at a stealth address.
const toA = deriveStealth(bankA.metaAddress);
await (await token.mintStealth(toA.stealthAddress, 1000n, toA.ephemeralPubKey, toA.viewTag)).wait();

// 2. Bank A scans only the token's own announcements and checks the metadata against the chain.
const annsA = await announcements(true);
const [foundA, ...restA] = scan(annsA, bankA.viewKey, bankA.spendKey);
check(foundA && restA.length === 0, 'bank A finds exactly one payment');
const metaA = parseTokenMetadata(annsA.find((a) => a.stealthAddress === foundA.stealthAddress)!.metadata);
check(metaA && metaA.token === tokenAddr && metaA.amount === 1000n, 'metadata says 1000 RD of this token');
check((await token.balanceOf(foundA.stealthAddress)) === 1000n, 'bank A stealth address holds 1000');
check((await provider.getBalance(foundA.stealthAddress)) === 0n, 'bank A stealth address has no native balance');

// 3. Bank A sends 400 to bank B from its unfunded stealth address (gas price 0).
const walletA = new Wallet(foundA.privateKey, provider);
const toB = deriveStealth(bankB.metaAddress);
await (await token.connect(walletA).getFunction('sendStealth')(toB.stealthAddress, 400n, toB.ephemeralPubKey, toB.viewTag, { gasPrice })).wait();
check((await token.balanceOf(foundA.stealthAddress)) === 600n, 'bank A keeps the 600 remainder');

// 4. Bank B scans and finds 400.
const annsB = await announcements(true);
const [foundB, ...restB] = scan(annsB, bankB.viewKey, bankB.spendKey);
check(foundB && restB.length === 0, 'bank B finds exactly one payment');
const metaB = parseTokenMetadata(annsB.find((a) => a.stealthAddress === foundB.stealthAddress)!.metadata);
check(metaB && metaB.token === tokenAddr && metaB.amount === 400n, 'bank B metadata says 400 RD of this token');
check((await token.balanceOf(foundB.stealthAddress)) === 400n, 'bank B stealth address holds 400');

// 5. Forged announcement: the issuer posts RD-looking metadata straight to the Announcer for bank B.
//    It carries caller = issuer, not the token, so the token-filtered scan must not see it.
const forged = deriveStealth(bankB.metaAddress);
await (await announcer.announce(1, forged.stealthAddress, forged.ephemeralPubKey, buildTokenMetadata(forged.viewTag, tokenAddr, 999n))).wait();
check(scan(await announcements(false), bankB.viewKey, bankB.spendKey).length === 2, 'unfiltered scan sees the forgery');
check(scan(await announcements(true), bankB.viewKey, bankB.spendKey).length === 1, 'token-filtered scan ignores the forgery');
check((await token.balanceOf(forged.stealthAddress)) === 0n, 'forged address holds nothing');

// 6. Both banks burn what they hold; supply returns to 0.
await (await token.connect(new Wallet(foundB.privateKey, provider)).getFunction('burn')(400n, { gasPrice })).wait();
await (await token.connect(walletA).getFunction('burn')(600n, { gasPrice })).wait();
check((await token.totalSupply()) === 0n, 'total supply is 0 after burns');

console.log('OK: mintStealth, scan, sendStealth, forgery ignored, burn; final supply 0');
