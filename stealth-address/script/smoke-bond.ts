// One-off DFABI bond smoke check against a live Besu network. Not part of CI.
// Needs the ERC1820 registry (node script/deploy-erc1820.ts).
// Usage: forge build && set -a && . ./.env.smoke && set +a && node script/smoke-bond.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { buildMemo, openMemo, type MemoContext } from '../ts/memo.ts';
import { buildBondMetadata, CERTIFICATE_LENGTH, parseBondMetadata, payloadWithoutCertificate, signCertificate } from '../ts/bond.ts';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from '../ts/stealth.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

// cacheTimeout -1: ethers otherwise reuses identical read results for 250 ms, which hides a state change just mined.
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
// The deployer plays owner, minter, controller and certificate signer (the custodian); production would split them.
const custodian = new Wallet(DEPLOYER_KEY, provider);
const TRANCHE_A = encodeBytes32String('TRANCHE-A');

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('FAILED: ' + msg);
}

async function reverts(call: Promise<unknown>, reason: string, msg: string): Promise<void> {
  try {
    await call;
  } catch (e: any) {
    check(e.reason === reason, `${msg} (expected revert "${reason}", got ${e.reason ?? e.shortMessage ?? e.message})`);
    return;
  }
  throw new Error(`FAILED: ${msg} (did not revert)`);
}

async function deploy(name: string, ...args: unknown[]): Promise<Contract> {
  const { abi, bytecode } = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  const c = await new ContractFactory(abi, bytecode.object, custodian).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());
check((await provider.getCode('0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24')) !== '0x', 'ERC1820 registry is deployed');

// Besu caps the eth_getLogs range, so read from the block before the deploy.
const fromBlock = await provider.getBlockNumber();
const announcer = await deploy('ERC5564Announcer');
const validator = await deploy('ERC1400TokensValidator');
const token = await deploy('DfabiBond', 'DFABI Series 1', 'DFB1', [custodian.address], [TRANCHE_A], await announcer.getAddress());
const tokenAddr = await token.getAddress();
const validatorAddr = await validator.getAddress();
console.log('announcer', await announcer.getAddress(), '| validator', validatorAddr, '| bond', tokenAddr);

// Setup: validator in nonce-based certificate mode, custodian as certificate signer, allowlist = custodian only
// (this is what locks the ERC-20 transfer path), custodian is already minter and controller.
const setup = [
  () => token.setTokenExtension(validatorAddr, 'ERC1400TokensValidator', true, false, false),
  () => validator.registerTokenSetup(tokenAddr, 1, true, false, false, false, []),
  () => validator.addCertificateSigner(tokenAddr, custodian.address),
  () => validator.addAllowlisted(tokenAddr, custodian.address),
];
for (const send of setup) await (await send()).wait(); // one at a time: they share the deployer's nonce

// The custodian signs the calldata of the exact call the holder will make, minus the certificate argument.
async function certificate(fn: string, holder: string, args: unknown[]): Promise<string> {
  const placeholder = token.interface.encodeFunctionData(fn, [...args, new Uint8Array(CERTIFICATE_LENGTH)]);
  const { timestamp } = (await provider.getBlock('latest'))!;
  return signCertificate(DEPLOYER_KEY!, {
    domainSeparator: await token.generateDomainSeparator(),
    msgSender: holder,
    token: tokenAddr,
    payload: payloadWithoutCertificate(placeholder),
    expiry: BigInt(timestamp) + 600n,
    nonce: await validator.usedCertificateNonce(tokenAddr, holder),
  });
}

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
const bankC = generateMetaAddress(); // a third bank
const bankAId = Wallet.createRandom(); // bank A's identity key (the custodian's identity key = DEPLOYER_KEY)

function pay(meta: string, senderKey: string, amount: bigint) {
  const ephemeralKey = hexlify(randomBytes(32));
  const s = deriveStealth(meta, ephemeralKey);
  const ctx: MemoContext = { chainId: net.chainId, token: tokenAddr, stealthAddress: s.stealthAddress, amount, ephemeralPubKey: s.ephemeralPubKey, partition: TRANCHE_A };
  return { s, memo: buildMemo({ senderKey, ephemeralKey, receiverMetaAddress: meta, ctx }) };
}

function memoOf(ann: Announcement, viewKey: string): { sender: string } | null {
  const m = parseBondMetadata(ann.metadata)!;
  return openMemo(m.memo, viewKey, { chainId: net.chainId, token: m.token, stealthAddress: ann.stealthAddress, amount: m.amount, ephemeralPubKey: ann.ephemeralPubKey, partition: m.partition });
}

// 1. The custodian issues 1000 units of tranche A to bank A at a stealth address.
const payA = pay(bankA.metaAddress, DEPLOYER_KEY, 1000n);
const toA = payA.s;
await (await token.issueByPartitionStealth(TRANCHE_A, toA.stealthAddress, 1000n, toA.ephemeralPubKey, toA.viewTag, payA.memo)).wait();

// 2. Bank A scans only the token's own announcements and checks the metadata against the chain.
const annsA = await announcements(true);
const [foundA, ...restA] = scan(annsA, bankA.viewKey, bankA.spendKey);
check(foundA && restA.length === 0, 'bank A finds exactly one payment');
const metaA = parseBondMetadata(annsA.find((a) => a.stealthAddress === foundA.stealthAddress)!.metadata);
check(metaA && metaA.token === tokenAddr && metaA.amount === 1000n && metaA.partition === TRANCHE_A, 'metadata says 1000 of tranche A of this token');
check((await token.balanceOfByPartition(TRANCHE_A, foundA.stealthAddress)) === 1000n, 'bank A stealth address holds 1000 of tranche A');
check((await provider.getBalance(foundA.stealthAddress)) === 0n, 'bank A stealth address has no native balance');

// 3. Bank A sends 400 to bank B from its unfunded stealth address: refused without a certificate,
//    refused through the ERC-20 path, accepted with the custodian's certificate.
const walletA = new Wallet(foundA.privateKey, provider);
const payB = pay(bankB.metaAddress, bankAId.privateKey, 400n);
const toB = payB.s;
const sendArgs = [TRANCHE_A, toB.stealthAddress, 400n, toB.ephemeralPubKey, toB.viewTag, payB.memo]; // the certificate stays the LAST argument
const asA = token.connect(walletA);
await reverts(asA.getFunction('transferByPartitionStealth').staticCall(...sendArgs, '0x'), '54', 'transfer without a certificate');
await reverts(asA.getFunction('transfer').staticCall(toB.stealthAddress, 1n), '54', 'ERC-20 transfer is locked');
const cert = await certificate('transferByPartitionStealth', foundA.stealthAddress, sendArgs);
await (await asA.getFunction('transferByPartitionStealth')(...sendArgs, cert, { gasPrice })).wait();
check((await token.balanceOfByPartition(TRANCHE_A, foundA.stealthAddress)) === 600n, 'bank A keeps the 600 remainder');
await reverts(asA.getFunction('transferByPartitionStealth').staticCall(...sendArgs, cert), '54', 'the same certificate cannot be replayed');

// 4. Bank B scans and finds 400 of tranche A.
const annsB = await announcements(true);
const [foundB, ...restB] = scan(annsB, bankB.viewKey, bankB.spendKey);
check(foundB && restB.length === 0, 'bank B finds exactly one payment');
const metaB = parseBondMetadata(annsB.find((a) => a.stealthAddress === foundB.stealthAddress)!.metadata);
check(metaB && metaB.token === tokenAddr && metaB.amount === 400n && metaB.partition === TRANCHE_A, 'bank B metadata says 400 of tranche A');
check((await token.balanceOfByPartition(TRANCHE_A, foundB.stealthAddress)) === 400n, 'bank B stealth address holds 400');

// 4a. Sender memos (they ride in the certified calldata, so the custodian vouched for them too).
const annOfA = annsA.find((a) => a.stealthAddress === foundA.stealthAddress)!;
const annOfB = annsB.find((a) => a.stealthAddress === foundB.stealthAddress)!;
check(memoOf(annOfA, bankA.viewKey)?.sender === custodian.address, 'bank A learns the issue came from the custodian');
check(memoOf(annOfB, bankB.viewKey)?.sender === bankAId.address, 'bank B learns the transfer came from bank A');
check(memoOf(annOfB, bankB.viewKey /* the custodian holds this view key */)?.sender === bankAId.address, 'custodian/BI reads the same memo with bank B view key');
check(memoOf(annOfB, bankC.viewKey) === null, 'a third bank cannot read the memo');

// 5. Forged announcement: the custodian wallet posts bond-looking metadata straight to the Announcer for bank B.
//    It carries caller = that wallet, not the token, so the token-filtered scan must not see it.
const forged = deriveStealth(bankB.metaAddress);
await (await announcer.announce(1, forged.stealthAddress, forged.ephemeralPubKey, buildBondMetadata(forged.viewTag, tokenAddr, 999n, TRANCHE_A))).wait();
check(scan(await announcements(false), bankB.viewKey, bankB.spendKey).length === 2, 'unfiltered scan sees the forgery');
check(scan(await announcements(true), bankB.viewKey, bankB.spendKey).length === 1, 'token-filtered scan ignores the forgery');
check((await token.balanceOfByPartition(TRANCHE_A, forged.stealthAddress)) === 0n, 'forged address holds nothing');

// 6. Both banks redeem what they hold (each redemption needs a certificate); tranche supply returns to 0.
const walletB = new Wallet(foundB.privateKey, provider);
for (const [wallet, amount] of [[walletB, 400n], [walletA, 600n]] as const) {
  const args = [TRANCHE_A, amount];
  const c = await certificate('redeemByPartition', wallet.address, args);
  await (await token.connect(wallet).getFunction('redeemByPartition')(...args, c, { gasPrice })).wait();
}
check((await token.totalSupplyByPartition(TRANCHE_A)) === 0n, 'tranche A supply is 0 after redemptions');
check((await token.totalSupply()) === 0n, 'total supply is 0 after redemptions');

console.log('OK: issue, scan, certified transfer with sender memo, no-certificate / ERC-20 / replay refused, memo readable by receiver and custodian but not a third bank, forgery ignored, redeem; final supply 0');
process.exit(0);
