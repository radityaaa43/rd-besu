// One-off RD smoke check against a live Besu network. Not part of CI.
// Usage: forge build && set -a && . ./.env.smoke && set +a && node script/smoke-rd.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, hexlify, randomBytes } from 'ethers';
import { buildMemo, openMemo, type MemoContext } from '../ts/memo.ts';
import { deriveStealth, generateMetaAddress, scan, scanAll, type Announcement } from '../ts/stealth.ts';
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
const bankC = generateMetaAddress(); // a third bank: its view key must not open anyone else's memo
const bankAId = Wallet.createRandom(); // bank A's identity key, signs the memos it sends (BI's identity key = issuer)

// A payment to `meta`: fresh ephemeral key, stealth address, and the sender memo for exactly that payment.
function pay(meta: string, senderKey: string, amount: bigint) {
  const ephemeralKey = hexlify(randomBytes(32));
  const s = deriveStealth(meta, ephemeralKey);
  const ctx: MemoContext = { chainId: net.chainId, token: tokenAddr, stealthAddress: s.stealthAddress, amount, ephemeralPubKey: s.ephemeralPubKey };
  return { s, ctx, memo: buildMemo({ senderKey, ephemeralKey, receiverMetaAddress: meta, ctx }) };
}

// Reads the memo out of an announcement the way a receiver does: prefix from the chain, memo = the tail.
function memoOf(ann: Announcement, viewKey: string): { sender: string } | null {
  const m = parseTokenMetadata(ann.metadata)!;
  return openMemo(m.memo, viewKey, { chainId: net.chainId, token: m.token, stealthAddress: ann.stealthAddress, amount: m.amount, ephemeralPubKey: ann.ephemeralPubKey });
}

// 1. BI funds bank A with 1000 RD at a stealth address.
const payA = pay(bankA.metaAddress, DEPLOYER_KEY, 1000n);
const toA = payA.s;
await (await token.mintStealth(toA.stealthAddress, 1000n, toA.ephemeralPubKey, toA.viewTag, payA.memo)).wait();

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
const payB = pay(bankB.metaAddress, bankAId.privateKey, 400n);
const toB = payB.s;
await (await token.connect(walletA).getFunction('sendStealth')(toB.stealthAddress, 400n, toB.ephemeralPubKey, toB.viewTag, payB.memo, { gasPrice })).wait();
check((await token.balanceOf(foundA.stealthAddress)) === 600n, 'bank A keeps the 600 remainder');

// 4. Bank B scans and finds 400.
const annsB = await announcements(true);
const [foundB, ...restB] = scan(annsB, bankB.viewKey, bankB.spendKey);
check(foundB && restB.length === 0, 'bank B finds exactly one payment');
const metaB = parseTokenMetadata(annsB.find((a) => a.stealthAddress === foundB.stealthAddress)!.metadata);
check(metaB && metaB.token === tokenAddr && metaB.amount === 400n, 'bank B metadata says 400 RD of this token');
check((await token.balanceOf(foundB.stealthAddress)) === 400n, 'bank B stealth address holds 400');

// 4a. Sender memos: each receiver learns the AUTHENTICATED sender; BI (holding the receiver's view key) learns it too;
//     a third bank's view key learns nothing.
const annOfA = annsB.find((a) => a.stealthAddress === foundA.stealthAddress)!;
const annOfB = annsB.find((a) => a.stealthAddress === foundB.stealthAddress)!;
check(memoOf(annOfA, bankA.viewKey)?.sender === issuer.address, 'bank A learns the mint came from BI');
check(memoOf(annOfB, bankB.viewKey)?.sender === bankAId.address, 'bank B learns the send came from bank A');
check(memoOf(annOfB, bankB.viewKey /* BI holds this view key */)?.sender === bankAId.address, 'BI reads the same memo with bank B view key');
check(memoOf(annOfB, bankC.viewKey) === null, 'a third bank cannot read the memo');
check(memoOf(annOfB, bankA.viewKey) === null, 'even the sender bank view key does not open another bank memo');

// 4b. BI holds each bank's view key + meta-address (never a spend key) and resolves every receiver to a bank.
const biView = [
  { id: 'bank-A', viewKey: bankA.viewKey, metaAddress: bankA.metaAddress },
  { id: 'bank-B', viewKey: bankB.viewKey, metaAddress: bankB.metaAddress },
];
const biSees = scanAll(annsB, biView).map((r) => [r.bank, r.announcement.stealthAddress]);
check(biSees.length === 2, 'BI resolves both RD receivers (mint and send)');
check(biSees.some(([bank, addr]) => bank === 'bank-A' && addr === foundA.stealthAddress), 'BI: the mint receiver is bank A');
check(biSees.some(([bank, addr]) => bank === 'bank-B' && addr === foundB.stealthAddress), 'BI: the send receiver is bank B');

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

console.log('OK: mintStealth, scan, sendStealth, sender memos (receiver, BI, third bank), BI view-key scan, forgery ignored, burn; final supply 0');
