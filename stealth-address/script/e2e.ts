// End-to-end test of every stealth feature on a live Besu network: ERC-6538 registry, RD, DFABI bond, BI view-key scan,
// memos, atomic DvP and the instrument registry. Each feature has happy cases and negative cases; a negative case
// asserts the EXACT revert error (custom error name, or revert string) or the exact thrown message.
// Deploys fresh contracts (no state from earlier runs). Needs the ERC1820 registry (node script/deploy-erc1820.ts).
// Usage: forge build && node script/e2e.ts [--md matrix.md]      (RPC_URL and DEPLOYER_KEY from the environment or .env.smoke)
// Output per case: ID | feature | happy/negative | expected | actual | PASS/FAIL | tx hash. Exit code 1 if any FAIL.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Contract, ContractFactory, Interface, JsonRpcProvider, type ContractRunner, type Signer, TypedDataEncoder, Wallet, ZeroAddress, ZeroHash, concat, encodeBytes32String,
  getBytes, hexlify, keccak256, randomBytes, toUtf8Bytes,
} from 'ethers';
import { CERTIFICATE_LENGTH, parseBondMetadata, payloadWithoutCertificate, signCertificate } from '../ts/bond.ts';
import { canonicalJson, loadProfile, recordHash, registrationArgs, validateRecord } from '../ts/instrument.ts';
import { buildMemo, encryptMemo, memoDigest, openMemo, type MemoContext } from '../ts/memo.ts';
import { deriveStealth, generateMetaAddress, scan, scanAll, scanView, type Announcement, type ViewKeyHolder } from '../ts/stealth.ts';
import { buildTokenMetadata, parseTokenMetadata } from '../ts/token.ts';

if (!process.env.RPC_URL || !process.env.DEPLOYER_KEY) {
  try { process.loadEnvFile('.env.smoke'); } catch { /* the check below reports what is missing */ }
}
const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY (or provide .env.smoke)');

const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
// The deployer plays BI (RD issuer), the custodian (bond minter, controller, certificate signer, escrow creator),
// the registry owner and the registrar. Every other actor is a fresh random wallet (gas price 0: no funds needed).
const custodian = new Wallet(DEPLOYER_KEY, provider);
const TRANCHE_A = encodeBytes32String('TRANCHE-A');
const BOND = 1000n;
const PRICE = 5_000_000n;
const WINDOW = 600n;

// ---------- result matrix ----------
type Row = { id: string; feature: string; kind: 'happy' | 'negative'; expected: string; actual: string; ok: boolean; tx: string };
const rows: Row[] = [];
const OK = 'all checks hold';
const verify = (...checks: [string, boolean][]) => {
  const bad = checks.find(([, c]) => !c);
  return bad ? `failed: ${bad[0]}` : OK;
};

async function run(id: string, feature: string, kind: Row['kind'], expected: string, fn: () => Promise<string | { actual: string; tx?: string }>) {
  let actual: string;
  let tx = '-';
  try {
    const r = await fn();
    if (typeof r === 'string') actual = r;
    else ({ actual, tx = '-' } = r);
  } catch (e: any) {
    actual = 'ERROR ' + (e.shortMessage ?? e.message);
  }
  const ok = actual === expected;
  rows.push({ id, feature, kind, expected, actual, ok, tx });
  console.log([id, feature, kind, expected, actual, ok ? 'PASS' : 'FAIL', tx].join(' | '));
}

// Decodes a revert to its exact name: custom error name, revert string, or "revert (no data)" for a bare require.
const ifaces: Interface[] = [];
async function rev(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'did not revert';
  } catch (e: any) {
    if (e.revert && e.revert.name !== 'Error' && e.revert.name !== 'Panic') return e.revert.name;
    if (e.reason === 'require(false)') return 'revert (no data)'; // ethers' name for empty revert data (a bare require, or a failed CREATE2)
    if (e.reason) return e.reason;
    if (typeof e.data === 'string' && e.data.length >= 10) {
      for (const i of ifaces) {
        const d = i.parseError(e.data);
        if (d) return d.name;
      }
      return 'unknown error ' + e.data.slice(0, 10);
    }
    if (e.code === 'CALL_EXCEPTION') return 'revert (no data)';
    return 'other: ' + (e.shortMessage ?? e.message);
  }
}
// The exact message of a thrown error, or 'did not throw'.
async function thrown(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'did not throw';
  } catch (e: any) {
    return e.message;
  }
}

// ---------- chain helpers ----------
const artifact = (name: string, file = name) => JSON.parse(readFileSync(`out/${file}.sol/${name}.json`, 'utf8'));
async function deploy(name: string, args: unknown[] = [], file = name): Promise<Contract> {
  const { abi, bytecode } = artifact(name, file);
  const c = await new ContractFactory(abi, bytecode.object, custodian).deploy(...args);
  await c.waitForDeployment();
  ifaces.push(c.interface);
  return c as unknown as Contract;
}
const sendTx = async (p: Promise<any>): Promise<string> => (await (await p).wait()).hash;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = async () => BigInt((await provider.getBlock('latest'))!.timestamp);
async function waitUntil(ts: bigint) {
  while ((await now()) < ts) {
    await (await custodian.sendTransaction({ to: custodian.address, value: 0 })).wait(); // keep blocks coming
    await sleep(2000);
  }
}
const fresh = () => Wallet.createRandom().connect(provider);
const as = (c: Contract, w: ContractRunner) => c.connect(w) as Contract;
const randomAddress = () => Wallet.createRandom().address;

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());
if ((await provider.getCode('0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24')) === '0x') throw new Error('ERC1820 registry is not deployed (node script/deploy-erc1820.ts)');

// ---------- deploy ----------
const fromBlock = await provider.getBlockNumber(); // Besu caps the eth_getLogs range: read from just before the deploy
const announcer = await deploy('ERC5564Announcer');
const registry = await deploy('ERC6538Registry');
const validator = await deploy('ERC1400TokensValidator');
const bond = await deploy('DfabiBond', ['DFABI Series 1', 'DFB1', [custodian.address], [TRANCHE_A], await announcer.getAddress()]);
const rd = await deploy('RupiahDigital', [custodian.address, await announcer.getAddress()]);
const factory = await deploy('DvPFactory', [custodian.address]);
const instruments = await deploy('InstrumentRegistry');
ifaces.push(new Interface(artifact('DvPEscrow').abi));
const [announcerAddr, registryAddr, bondAddr, rdAddr, factoryAddr, instrumentsAddr] = await Promise.all(
  [announcer, registry, bond, rd, factory, instruments].map((c) => c.getAddress()),
);
console.log('announcer', announcerAddr, '| registry', registryAddr, '| bond', bondAddr, '| rd', rdAddr, '| factory', factoryAddr, '| instruments', instrumentsAddr);
for (const send of [
  () => bond.setTokenExtension(validator.target, 'ERC1400TokensValidator', true, false, false),
  () => validator.registerTokenSetup(bondAddr, 1, true, false, false, false, []),
  () => validator.addCertificateSigner(bondAddr, custodian.address),
  () => validator.addAllowlisted(bondAddr, custodian.address),
  () => instruments.setRegistrar(custodian.address, true),
]) await (await send()).wait();

// The custodian signs the calldata of the exact call `msgSender` will make, minus the certificate argument.
async function cert(fn: string, msgSender: string, args: readonly unknown[], o: { expiry?: bigint; key?: string; nonce?: bigint } = {}): Promise<string> {
  const placeholder = bond.interface.encodeFunctionData(fn, [...args, new Uint8Array(CERTIFICATE_LENGTH)]);
  return signCertificate(o.key ?? DEPLOYER_KEY!, {
    domainSeparator: await bond.generateDomainSeparator(),
    msgSender,
    token: bondAddr,
    payload: payloadWithoutCertificate(placeholder),
    expiry: o.expiry ?? (await now()) + 600n,
    nonce: o.nonce ?? (await validator.usedCertificateNonce(bondAddr, msgSender)),
  });
}

async function announcements(token: string | null): Promise<Announcement[]> {
  const logs = await announcer.queryFilter(announcer.filters.Announcement(null, null, token), fromBlock);
  return logs.map((l: any) => ({ schemeId: l.args.schemeId, stealthAddress: l.args.stealthAddress, ephemeralPubKey: l.args.ephemeralPubKey, metadata: l.args.metadata }));
}

// A payment to `meta` with its memo, signed by `senderKey`.
function pay(meta: string, senderKey: string, token: string, amount: bigint, partition?: string) {
  const ephemeralKey = hexlify(randomBytes(32));
  const s = deriveStealth(meta, ephemeralKey);
  const ctx: MemoContext = { chainId: net.chainId, token, stealthAddress: s.stealthAddress, amount, ephemeralPubKey: s.ephemeralPubKey, partition };
  return { s, ctx, ephemeralKey, memo: buildMemo({ senderKey, ephemeralKey, receiverMetaAddress: meta, ctx }) };
}
// What a receiver (or BI, holding the receiver's view key) reads from an announcement: token, amount, partition and the authenticated sender.
function read(ann: Announcement, viewKey: string, kind: 'rd' | 'bond') {
  const m: any = kind === 'rd' ? parseTokenMetadata(ann.metadata) : parseBondMetadata(ann.metadata);
  const ctx: MemoContext = { chainId: net.chainId, token: m.token, stealthAddress: ann.stealthAddress, amount: m.amount, ephemeralPubKey: ann.ephemeralPubKey, partition: m.partition };
  return { token: m.token as string, amount: m.amount as bigint, partition: m.partition as string | undefined, memo: m.memo as string, ctx, sender: openMemo(m.memo, viewKey, ctx)?.sender ?? null };
}
// BI's view: every announcement resolved to a bank, with amount and authenticated sender.
const biRows = (anns: Announcement[], holders: ViewKeyHolder[], kind: 'rd' | 'bond') =>
  scanAll(anns, holders).map((r) => {
    const p = read(r.announcement, holders.find((h) => h.id === r.bank)!.viewKey, kind);
    return `${r.bank}:${p.amount}:${p.sender}`;
  }).sort().join(' | ');

// Banks. A and B are the main pair; C takes no part in anything and must see nothing.
const bankA = generateMetaAddress();
const bankB = generateMetaAddress();
const bankC = generateMetaAddress();
const idA = Wallet.createRandom(); // bank A's identity key (signs the memos it sends)
const holdersAB: ViewKeyHolder[] = [
  { id: 'bank-A', viewKey: bankA.viewKey, metaAddress: bankA.metaAddress },
  { id: 'bank-B', viewKey: bankB.viewKey, metaAddress: bankB.metaAddress },
];
const holderC: ViewKeyHolder[] = [{ id: 'bank-C', viewKey: bankC.viewKey, metaAddress: bankC.metaAddress }];
const stranger = fresh();

// =====================================================================================================
// 1. ERC-6538 key registry
// =====================================================================================================
const F_REG = 'ERC-6538 registry';
const regDomain = { name: 'ERC6538Registry', version: '1.0', chainId: net.chainId, verifyingContract: registryAddr };
const regTypes = { Erc6538RegistryEntry: [{ name: 'schemeId', type: 'uint256' }, { name: 'stealthMetaAddress', type: 'bytes' }, { name: 'nonce', type: 'uint256' }] };
const entry = (schemeId: number, meta: string, nonce: bigint) => ({ schemeId, stealthMetaAddress: meta, nonce });
const signEntry = (w: Signer, schemeId: number, meta: string, nonce: bigint) => w.signTypedData(regDomain, regTypes, entry(schemeId, meta, nonce));
const registrantA = fresh();

await run('REG-01', F_REG, 'happy', OK, async () => {
  const tx = await sendTx(as(registry, registrantA).registerKeys(1, bankA.metaAddress, { gasPrice }));
  return { tx, actual: verify(['meta-address stored under the registrant', (await registry.stealthMetaAddressOf(registrantA.address, 1)) === bankA.metaAddress]) };
});
await run('REG-02', F_REG, 'negative', 'InvalidMetaAddressLength', () => rev(as(registry, registrantA).registerKeys.staticCall(1, '0x' + '02'.repeat(65))));
await run('REG-03', F_REG, 'negative', 'InvalidMetaAddressLength', () => rev(as(registry, registrantA).registerKeys.staticCall(1, '0x')));
await run('REG-04', F_REG, 'happy', OK, async () => { // sender flow: read registry, derive, announce; recipient scans and spends
  const s = deriveStealth(await registry.stealthMetaAddressOf(registrantA.address, 1));
  const tx = await sendTx(announcer.announce(1, s.stealthAddress, s.ephemeralPubKey, s.viewTag));
  const [found, ...rest] = scan(await announcements(custodian.address), bankA.viewKey, bankA.spendKey);
  const w = new Wallet(found.privateKey, provider);
  const rc = await (await w.sendTransaction({ to: custodian.address, value: 0n, gasPrice, gasLimit: 21000n })).wait();
  return { tx, actual: verify(['scan finds exactly the derived address', found?.stealthAddress === s.stealthAddress && rest.length === 0], ['tx signed by the stealth key', rc?.from === s.stealthAddress]) };
});

// On behalf: a wallet that never sends a tx signs EIP-712; someone else submits it.
const onBehalf = fresh();
const metaX = generateMetaAddress().metaAddress;
const metaY = generateMetaAddress().metaAddress;
const sigX = await signEntry(onBehalf, 1, metaX, 0n);
await run('REG-05', F_REG, 'happy', 'stored, nonce 1', async () => {
  const tx = await sendTx(registry.registerKeysOnBehalf(onBehalf.address, 1, sigX, metaX));
  const stored = (await registry.stealthMetaAddressOf(onBehalf.address, 1)) === metaX;
  return { tx, actual: stored ? `stored, nonce ${await registry.nonceOf(onBehalf.address)}` : 'not stored' };
});
await run('REG-06', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', () => rev(registry.registerKeysOnBehalf.staticCall(onBehalf.address, 1, sigX, metaX))); // replay: nonce consumed
const o2 = fresh();
await run('REG-07', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', async () => // signed for nonce 7, registry expects 0
  rev(registry.registerKeysOnBehalf.staticCall(o2.address, 1, await signEntry(o2, 1, metaX, 7n), metaX)));
await run('REG-08', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', async () => // another wallet signed for o2's address
  rev(registry.registerKeysOnBehalf.staticCall(o2.address, 1, await signEntry(onBehalf, 1, metaX, 0n), metaX)));
await run('REG-09', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', async () => // signed for metaX, submitted with metaY
  rev(registry.registerKeysOnBehalf.staticCall(o2.address, 1, await signEntry(o2, 1, metaX, 0n), metaY)));
await run('REG-10', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', async () => // signed for scheme 1, submitted as scheme 2
  rev(registry.registerKeysOnBehalf.staticCall(o2.address, 2, await signEntry(o2, 1, metaX, 0n), metaX)));
await run('REG-11', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', () => rev(registry.registerKeysOnBehalf.staticCall(o2.address, 1, '0x1234', metaX)));
await run('REG-12', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', () => rev(registry.registerKeysOnBehalf.staticCall(o2.address, 1, hexlify(randomBytes(65)), metaX)));
await run('REG-13', F_REG, 'negative', 'InvalidMetaAddressLength', async () => // length is checked before the signature
  rev(registry.registerKeysOnBehalf.staticCall(o2.address, 1, await signEntry(o2, 1, '0x' + '02'.repeat(65), 0n), '0x' + '02'.repeat(65))));
await run('REG-14', F_REG, 'happy', OK, async () => verify(['DOMAIN_SEPARATOR equals the EIP-712 domain hash', (await registry.DOMAIN_SEPARATOR()) === TypedDataEncoder.hashDomain(regDomain)]));
// incrementNonce revokes a signature that was signed but not yet submitted.
const o3 = fresh();
const sig3 = await signEntry(o3, 1, metaX, 0n);
await run('REG-15', F_REG, 'happy', 'nonce 0 -> 1', async () => {
  const before = await registry.nonceOf(o3.address);
  const tx = await sendTx(as(registry, o3).incrementNonce({ gasPrice }));
  return { tx, actual: `nonce ${before} -> ${await registry.nonceOf(o3.address)}` };
});
await run('REG-16', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', () => rev(registry.registerKeysOnBehalf.staticCall(o3.address, 1, sig3, metaX)));
// ERC-1271: a contract wallet (test mock that accepts exactly one digest).
const MAGIC = '0x1626ba7e';
const digestFor = (meta: string, nonce: bigint) => TypedDataEncoder.hash(regDomain, regTypes, entry(1, meta, nonce));
const w1271 = await deploy('Wallet1271', [digestFor(metaX, 0n), MAGIC], 'ERC6538Registry.t');
await run('REG-17', F_REG, 'happy', 'stored, nonce 1', async () => { // the signature bytes are irrelevant to the mock; only the digest counts
  const tx = await sendTx(registry.registerKeysOnBehalf(await w1271.getAddress(), 1, '0x1234', metaX));
  const stored = (await registry.stealthMetaAddressOf(await w1271.getAddress(), 1)) === metaX;
  return { tx, actual: stored ? `stored, nonce ${await registry.nonceOf(await w1271.getAddress())}` : 'not stored' };
});
const wBadMagic = await deploy('Wallet1271', [digestFor(metaX, 0n), '0xdeadbeef'], 'ERC6538Registry.t');
await run('REG-18', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', async () => rev(registry.registerKeysOnBehalf.staticCall(await wBadMagic.getAddress(), 1, '0x1234', metaX)));
const wOtherDigest = await deploy('Wallet1271', [hexlify(randomBytes(32)), MAGIC], 'ERC6538Registry.t');
await run('REG-19', F_REG, 'negative', 'ERC6538Registry__InvalidSignature', async () => rev(registry.registerKeysOnBehalf.staticCall(await wOtherDigest.getAddress(), 1, '0x1234', metaX)));

// =====================================================================================================
// 2. RD: issuance, transfer, memo, burn
// =====================================================================================================
const walletOf = (f: { privateKey: string }) => new Wallet(f.privateKey, provider);
const payA = pay(bankA.metaAddress, DEPLOYER_KEY, rdAddr, 1000n);
await run('RD-01', 'RD issuance (mintStealth)', 'happy', 'balance 1000, supply +1000', async () => {
  const supply = await rd.totalSupply();
  const tx = await sendTx(rd.mintStealth(payA.s.stealthAddress, 1000n, payA.s.ephemeralPubKey, payA.s.viewTag, payA.memo));
  return { tx, actual: `balance ${await rd.balanceOf(payA.s.stealthAddress)}, supply +${(await rd.totalSupply()) - supply}` };
});
const mintArgs = (p: ReturnType<typeof pay>, amount: bigint) => [p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo] as const;
await run('RD-02', 'RD issuance (mintStealth)', 'negative', 'OnlyIssuer', () => rev(as(rd, stranger).mintStealth.staticCall(...mintArgs(payA, 1000n))));
await run('RD-03', 'RD issuance (mint)', 'negative', 'OnlyIssuer', () => rev(as(rd, stranger).mint.staticCall(stranger.address, 1n)));
await run('RD-04', 'RD issuance (mint)', 'happy', 'balance 5', async () => {
  const to = randomAddress();
  const tx = await sendTx(rd.mint(to, 5n));
  return { tx, actual: `balance ${await rd.balanceOf(to)}` };
});
await run('RD-05', 'RD issuance (mintStealth)', 'negative', 'InvalidEphemeralPubKey', () => rev(rd.mintStealth.staticCall(payA.s.stealthAddress, 1n, '0x' + '02'.repeat(32), payA.s.viewTag, '0x')));
await run('RD-06', 'RD issuance (mintStealth)', 'negative', 'ZeroAmount', () => rev(rd.mintStealth.staticCall(...mintArgs(payA, 0n))));
await run('RD-07', 'RD issuance (mintStealth)', 'negative', 'MemoTooLong', () => rev(rd.mintStealth.staticCall(payA.s.stealthAddress, 1n, payA.s.ephemeralPubKey, payA.s.viewTag, '0x' + '00'.repeat(257))));
await run('RD-08', 'RD issuance (mintStealth)', 'happy', 'memo of 256 bytes and an empty memo are accepted', async () => {
  const a = await rev(rd.mintStealth.staticCall(payA.s.stealthAddress, 1n, payA.s.ephemeralPubKey, payA.s.viewTag, '0x' + '00'.repeat(256)));
  const b = await rev(rd.mintStealth.staticCall(payA.s.stealthAddress, 1n, payA.s.ephemeralPubKey, payA.s.viewTag, '0x'));
  return a === 'did not revert' && b === 'did not revert' ? 'memo of 256 bytes and an empty memo are accepted' : `256 bytes: ${a}; empty: ${b}`;
});

const annsRd1 = await announcements(rdAddr);
const [foundA] = scan(annsRd1, bankA.viewKey, bankA.spendKey);
const walletA = walletOf(foundA);
const payB = pay(bankB.metaAddress, idA.privateKey, rdAddr, 400n);
const sendArgs = (p: ReturnType<typeof pay>, amount: bigint) => [p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo] as const;
await run('RD-09', 'RD transfer (sendStealth)', 'happy', 'A 600, B 400', async () => {
  const tx = await sendTx(as(rd, walletA).sendStealth(...sendArgs(payB, 400n), { gasPrice }));
  return { tx, actual: `A ${await rd.balanceOf(foundA.stealthAddress)}, B ${await rd.balanceOf(payB.s.stealthAddress)}` };
});
await run('RD-10', 'RD transfer (sendStealth)', 'negative', 'ERC20InsufficientBalance', () => rev(as(rd, walletA).sendStealth.staticCall(...sendArgs(payB, 601n)))); // A holds 600
await run('RD-11', 'RD transfer (sendStealth)', 'negative', 'ERC20InsufficientBalance', () => rev(as(rd, stranger).sendStealth.staticCall(...sendArgs(payB, 1n))));
await run('RD-12', 'RD transfer (sendStealth)', 'negative', 'ERC20InvalidReceiver', () => rev(as(rd, walletA).sendStealth.staticCall(ZeroAddress, 1n, payB.s.ephemeralPubKey, payB.s.viewTag, '0x')));
await run('RD-13', 'RD transfer (sendStealth)', 'negative', 'MemoTooLong', () => rev(as(rd, walletA).sendStealth.staticCall(payB.s.stealthAddress, 1n, payB.s.ephemeralPubKey, payB.s.viewTag, '0x' + '00'.repeat(257))));
await run('RD-14', 'RD transfer (sendStealth)', 'negative', 'ZeroAmount', () => rev(as(rd, walletA).sendStealth.staticCall(...sendArgs(payB, 0n))));
await run('RD-15', 'RD transfer (sendStealth)', 'negative', 'InvalidEphemeralPubKey', () => rev(as(rd, walletA).sendStealth.staticCall(payB.s.stealthAddress, 1n, '0x' + '02'.repeat(34), payB.s.viewTag, '0x')));

const annsRd = await announcements(rdAddr);
const [foundB, ...restB] = scan(annsRd, bankB.viewKey, bankB.spendKey);
const annOfA = annsRd.find((a) => a.stealthAddress === foundA.stealthAddress)!;
const annOfB = annsRd.find((a) => a.stealthAddress === foundB.stealthAddress)!;
await run('RD-16', 'RD scan (recipient)', 'happy', 'B finds 1 payment: 400 RD of this token at its derived address', async () => {
  const p = read(annOfB, bankB.viewKey, 'rd');
  return restB.length === 0 && foundB.stealthAddress === payB.s.stealthAddress && p.amount === 400n && p.token === rdAddr
    ? 'B finds 1 payment: 400 RD of this token at its derived address' : `B found ${restB.length + 1}, amount ${p.amount}, token ${p.token}`;
});
await run('RD-17', 'RD sender memo (AES-GCM)', 'happy', `B learns ${idA.address}; A learns ${custodian.address}`, async () =>
  `B learns ${read(annOfB, bankB.viewKey, 'rd').sender}; A learns ${read(annOfA, bankA.viewKey, 'rd').sender}`);
await run('RD-18', 'RD scan (third bank)', 'negative', '0 matches', async () => `${scan(annsRd, bankC.viewKey, bankC.spendKey).length} matches`);
await run('RD-19', 'RD sender memo (AES-GCM)', 'negative', 'third bank view key opens nothing', async () =>
  openMemo(read(annOfB, bankB.viewKey, 'rd').memo, bankC.viewKey, read(annOfB, bankB.viewKey, 'rd').ctx) === null ? 'third bank view key opens nothing' : 'third bank read the memo');
await run('RD-20', 'RD sender memo (AES-GCM)', 'negative', "bank A's view key does not open B's memo", async () => {
  const p = read(annOfB, bankB.viewKey, 'rd');
  return openMemo(p.memo, bankA.viewKey, p.ctx) === null ? "bank A's view key does not open B's memo" : 'A read the memo';
});
const goodB = read(annOfB, bankB.viewKey, 'rd');
const flip = (hex: string, i: number) => { const b = getBytes(hex); b[i] ^= 1; return hexlify(b); };
await run('RD-21', 'RD sender memo (AES-GCM)', 'negative', 'tampered ciphertext does not decrypt', async () =>
  openMemo(flip(goodB.memo, 10), bankB.viewKey, goodB.ctx) === null ? 'tampered ciphertext does not decrypt' : 'tampered memo was accepted');
await run('RD-22', 'RD sender memo (AES-GCM)', 'negative', 'tampered auth tag does not decrypt', async () =>
  openMemo(flip(goodB.memo, goodB.memo.length / 2 - 2), bankB.viewKey, goodB.ctx) === null ? 'tampered auth tag does not decrypt' : 'tampered memo was accepted');
await run('RD-23', 'RD sender memo (AES-GCM)', 'negative', 'truncated memo does not decrypt', async () =>
  openMemo(goodB.memo.slice(0, -2), bankB.viewKey, goodB.ctx) === null ? 'truncated memo does not decrypt' : 'truncated memo was accepted');
await run('RD-24', 'RD sender memo (AES-GCM)', 'negative', 'memo replayed on another payment (other amount) is refused', async () =>
  openMemo(goodB.memo, bankB.viewKey, { ...goodB.ctx, amount: 401n }) === null ? 'memo replayed on another payment (other amount) is refused' : 'replayed memo was accepted');
await run('RD-25', 'RD sender memo (AES-GCM)', 'negative', 'memo whose signer is not the claimed sender is refused', async () => {
  const forged = encryptMemo(getBytes(concat([idA.address, await custodian.signMessage('x')])), payB.ephemeralKey, bankB.metaAddress);
  return openMemo(forged, bankB.viewKey, goodB.ctx) === null ? 'memo whose signer is not the claimed sender is refused' : 'forged sender accepted';
});
await run('RD-26', 'RD sender memo (AES-GCM)', 'negative', 'ctx.ephemeralPubKey is not the public key of ephemeralKey', () =>
  thrown(() => buildMemo({ senderKey: DEPLOYER_KEY!, ephemeralKey: payB.ephemeralKey, receiverMetaAddress: bankB.metaAddress, ctx: { ...goodB.ctx, ephemeralPubKey: payA.s.ephemeralPubKey } })));
await run('RD-27', 'RD metadata (ts)', 'negative', 'memo longer than 256 bytes', () => thrown(() => buildTokenMetadata('0xab', rdAddr, 1n, '0x' + '00'.repeat(257))));
await run('RD-28', 'RD metadata (ts)', 'negative', 'null, null', async () => // not RD metadata: too short; right length but another selector
  `${parseTokenMetadata('0x1234')}, ${parseTokenMetadata(concat(['0xab', '0xdeadbeef', rdAddr, '0x' + '00'.repeat(32)]))}`);
const forgedRd = deriveStealth(bankB.metaAddress);
await run('RD-29', 'RD scan (forged announcement)', 'negative', 'unfiltered scan 2 (sees the forgery), token-filtered scan 1, forged address holds 0', async () => {
  await sendTx(announcer.announce(1, forgedRd.stealthAddress, forgedRd.ephemeralPubKey, buildTokenMetadata(forgedRd.viewTag, rdAddr, 999n)));
  const all = scan(await announcements(null), bankB.viewKey, bankB.spendKey).length;
  const filtered = scan(await announcements(rdAddr), bankB.viewKey, bankB.spendKey).length;
  return `unfiltered scan ${all} (sees the forgery), token-filtered scan ${filtered}, forged address holds ${await rd.balanceOf(forgedRd.stealthAddress)}`;
});
await run('RD-30', 'BI view-key scan (RD)', 'happy', `bank-A:1000:${custodian.address} | bank-B:400:${idA.address}`, async () => biRows(await announcements(rdAddr), holdersAB, 'rd'));
await run('RD-31', 'BI view-key scan (RD)', 'negative', 'view key does not match meta-address of bank-A', () =>
  thrown(() => scanView([], { id: 'bank-A', viewKey: bankB.viewKey, metaAddress: bankA.metaAddress })));
await run('RD-32', 'BI view-key scan (RD)', 'negative', 'third bank resolves 0 announcements', async () => `third bank resolves ${scanAll(await announcements(rdAddr), holderC).length} announcements`);
await run('RD-33', 'RD burn', 'negative', 'ERC20InsufficientBalance', () => rev(as(rd, walletOf(foundB)).burn.staticCall(401n))); // B holds 400
await run('RD-34', 'RD burn', 'negative', 'ERC20InsufficientAllowance', () => rev(as(rd, stranger).burnFrom.staticCall(foundB.stealthAddress, 1n)));
await run('RD-35', 'RD burn', 'happy', 'B 0, supply -400', async () => {
  const supply = await rd.totalSupply();
  const tx = await sendTx(as(rd, walletOf(foundB)).burn(400n, { gasPrice }));
  return { tx, actual: `B ${await rd.balanceOf(foundB.stealthAddress)}, supply -${supply - (await rd.totalSupply())}` };
});

// =====================================================================================================
// 3. DFABI bond: issuance with certificate, stealth transfer, redeem
// =====================================================================================================
const bondPayA = pay(bankA.metaAddress, DEPLOYER_KEY, bondAddr, 1000n, TRANCHE_A);
const issueArgs = (p: ReturnType<typeof pay>, amount: bigint) => [TRANCHE_A, p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo] as const;
await run('BOND-01', 'DFABI issuance', 'happy', 'A 1000 of tranche A, tranche supply +1000', async () => {
  const supply = await bond.totalSupplyByPartition(TRANCHE_A);
  const tx = await sendTx(bond.issueByPartitionStealth(...issueArgs(bondPayA, 1000n)));
  return { tx, actual: `A ${await bond.balanceOfByPartition(TRANCHE_A, bondPayA.s.stealthAddress)} of tranche A, tranche supply +${(await bond.totalSupplyByPartition(TRANCHE_A)) - supply}` };
});
await run('BOND-02', 'DFABI issuance', 'negative', 'revert (no data)', () => rev(as(bond, stranger).issueByPartitionStealth.staticCall(...issueArgs(bondPayA, 1000n)))); // onlyMinter is a bare require
await run('BOND-03', 'DFABI issuance', 'negative', 'InvalidEphemeralPubKey', () => rev(bond.issueByPartitionStealth.staticCall(TRANCHE_A, bondPayA.s.stealthAddress, 1n, '0x' + '02'.repeat(32), bondPayA.s.viewTag, '0x')));
await run('BOND-04', 'DFABI issuance', 'negative', 'ZeroAmount', () => rev(bond.issueByPartitionStealth.staticCall(...issueArgs(bondPayA, 0n))));
await run('BOND-05', 'DFABI issuance', 'negative', 'MemoTooLong', () => rev(bond.issueByPartitionStealth.staticCall(TRANCHE_A, bondPayA.s.stealthAddress, 1n, bondPayA.s.ephemeralPubKey, bondPayA.s.viewTag, '0x' + '00'.repeat(257))));

const [bondFoundA] = scan(await announcements(bondAddr), bankA.viewKey, bankA.spendKey);
const bondWalletA = walletOf(bondFoundA);
const bondPayB = pay(bankB.metaAddress, idA.privateKey, bondAddr, 400n, TRANCHE_A);
const xferFn = 'transferByPartitionStealth';
const xferArgs = (p: ReturnType<typeof pay>, amount: bigint) => [TRANCHE_A, p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo] as const; // the certificate stays the LAST argument
const xfer = (amount: bigint) => xferArgs(bondPayB, amount);
const asBondA = as(bond, bondWalletA);
const certA = await cert(xferFn, bondFoundA.stealthAddress, xfer(400n));
await run('BOND-06', 'DFABI stealth transfer', 'negative', '54', () => rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), '0x')));
await run('BOND-07', 'DFABI stealth transfer', 'negative', '54', () => rev(asBondA.transfer.staticCall(bondPayB.s.stealthAddress, 1n))); // the ERC-20 path is locked
await run('BOND-08', 'DFABI stealth transfer', 'negative', '54', async () => // expired certificate
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), await cert(xferFn, bondFoundA.stealthAddress, xfer(400n), { expiry: (await now()) - 1n }))));
await run('BOND-09', 'DFABI stealth transfer', 'negative', '54', async () => // signed by a key that is not a certificate signer
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), await cert(xferFn, bondFoundA.stealthAddress, xfer(400n), { key: stranger.privateKey }))));
await run('BOND-10', 'DFABI stealth transfer', 'negative', '54', async () => // certificate issued for another sender
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), await cert(xferFn, randomAddress(), xfer(400n)))));
await run('BOND-11', 'DFABI stealth transfer', 'negative', '54', async () => // certificate covers 399, call sends 400
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), await cert(xferFn, bondFoundA.stealthAddress, xfer(399n)))));
await run('BOND-12', 'DFABI stealth transfer', 'negative', '54', async () => // certificate for another memo
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), await cert(xferFn, bondFoundA.stealthAddress, [...xfer(400n).slice(0, 5), '0x00'] as unknown[]))));
await run('BOND-13', 'DFABI stealth transfer', 'negative', '54', async () => // wrong nonce
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), await cert(xferFn, bondFoundA.stealthAddress, xfer(400n), { nonce: 5n }))));
await run('BOND-14', 'DFABI stealth transfer', 'negative', 'MemoTooLong', async () =>
  rev(asBondA.transferByPartitionStealth.staticCall(TRANCHE_A, bondPayB.s.stealthAddress, 400n, bondPayB.s.ephemeralPubKey, bondPayB.s.viewTag, '0x' + '00'.repeat(257), certA)));
await run('BOND-15', 'DFABI stealth transfer', 'negative', 'InvalidEphemeralPubKey', async () =>
  rev(asBondA.transferByPartitionStealth.staticCall(TRANCHE_A, bondPayB.s.stealthAddress, 400n, '0x' + '02'.repeat(32), bondPayB.s.viewTag, '0x', certA)));
await run('BOND-16', 'DFABI stealth transfer', 'negative', 'ZeroAmount', async () =>
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(0n), certA)));
await run('BOND-17', 'DFABI stealth transfer', 'negative', '52', async () => // valid certificate, but A holds 1000 and sends 1001
  rev(asBondA.transferByPartitionStealth.staticCall(...xfer(1001n), await cert(xferFn, bondFoundA.stealthAddress, xfer(1001n)))));
await run('BOND-18', 'DFABI stealth transfer', 'happy', 'A 600, B 400 of tranche A', async () => {
  const tx = await sendTx(asBondA.transferByPartitionStealth(...xfer(400n), certA, { gasPrice }));
  return { tx, actual: `A ${await bond.balanceOfByPartition(TRANCHE_A, bondFoundA.stealthAddress)}, B ${await bond.balanceOfByPartition(TRANCHE_A, bondPayB.s.stealthAddress)} of tranche A` };
});
await run('BOND-19', 'DFABI stealth transfer', 'negative', '54', () => rev(asBondA.transferByPartitionStealth.staticCall(...xfer(400n), certA))); // replay of the certificate just used

const annsBond = await announcements(bondAddr);
const [bondFoundB, ...bondRestB] = scan(annsBond, bankB.viewKey, bankB.spendKey);
const bondAnnA = annsBond.find((a) => a.stealthAddress === bondFoundA.stealthAddress)!;
const bondAnnB = annsBond.find((a) => a.stealthAddress === bondFoundB.stealthAddress)!;
const goodBondB = read(bondAnnB, bankB.viewKey, 'bond');
await run('BOND-20', 'DFABI scan (recipient)', 'happy', 'B finds 1 payment: 400 of tranche A of this token', async () =>
  bondRestB.length === 0 && bondFoundB.stealthAddress === bondPayB.s.stealthAddress && goodBondB.amount === 400n && goodBondB.partition === TRANCHE_A && goodBondB.token === bondAddr
    ? 'B finds 1 payment: 400 of tranche A of this token' : `B found ${bondRestB.length + 1}, amount ${goodBondB.amount}, partition ${goodBondB.partition}`);
await run('BOND-21', 'DFABI sender memo (AES-GCM)', 'happy', `B learns ${idA.address}; A learns ${custodian.address}`, async () =>
  `B learns ${goodBondB.sender}; A learns ${read(bondAnnA, bankA.viewKey, 'bond').sender}`);
await run('BOND-22', 'DFABI scan (third bank)', 'negative', '0 matches, memo not readable', async () => {
  const n = scan(annsBond, bankC.viewKey, bankC.spendKey).length;
  const opened = openMemo(goodBondB.memo, bankC.viewKey, goodBondB.ctx);
  return n === 0 && opened === null ? '0 matches, memo not readable' : `${n} matches, memo ${opened ? 'read' : 'not readable'}`;
});
await run('BOND-23', 'DFABI sender memo (AES-GCM)', 'negative', 'tampered ciphertext and a memo moved to another tranche both fail', async () => {
  const a = openMemo(flip(goodBondB.memo, 10), bankB.viewKey, goodBondB.ctx);
  const b = openMemo(goodBondB.memo, bankB.viewKey, { ...goodBondB.ctx, partition: encodeBytes32String('TRANCHE-B') });
  return a === null && b === null ? 'tampered ciphertext and a memo moved to another tranche both fail' : 'a bad memo was accepted';
});
const forgedBond = deriveStealth(bankB.metaAddress);
await run('BOND-24', 'DFABI scan (forged announcement)', 'negative', 'token-filtered scan 1, forged address holds 0', async () => {
  await sendTx(announcer.announce(1, forgedBond.stealthAddress, forgedBond.ephemeralPubKey, concat([forgedBond.viewTag, '0xf3d490db', bondAddr, '0x' + (999).toString(16).padStart(64, '0'), TRANCHE_A])));
  return `token-filtered scan ${scan(await announcements(bondAddr), bankB.viewKey, bankB.spendKey).length}, forged address holds ${await bond.balanceOfByPartition(TRANCHE_A, forgedBond.stealthAddress)}`;
});
await run('BOND-25', 'BI view-key scan (DFABI)', 'happy', `bank-A:1000:${custodian.address} | bank-B:400:${idA.address}`, async () => biRows(await announcements(bondAddr), holdersAB, 'bond'));
await run('BOND-26', 'BI view-key scan (DFABI)', 'negative', 'third bank resolves 0 announcements', async () => `third bank resolves ${scanAll(await announcements(bondAddr), holderC).length} announcements`);
// Redeem (needs a certificate like any move): B redeems 400, A redeems 600.
const bondWalletB = walletOf(bondFoundB);
const redeemCert = (holder: string, amount: bigint) => cert('redeemByPartition', holder, [TRANCHE_A, amount]);
await run('BOND-27', 'DFABI redeem', 'negative', '54', () => rev(as(bond, bondWalletB).redeemByPartition.staticCall(TRANCHE_A, 400n, '0x')));
await run('BOND-28', 'DFABI redeem', 'negative', '54', async () => // certificate for 300, call redeems 400
  rev(as(bond, bondWalletB).redeemByPartition.staticCall(TRANCHE_A, 400n, await redeemCert(bondFoundB.stealthAddress, 300n))));
await run('BOND-29', 'DFABI redeem', 'negative', '52', async () => // valid certificate, B holds 400 and redeems 401
  rev(as(bond, bondWalletB).redeemByPartition.staticCall(TRANCHE_A, 401n, await redeemCert(bondFoundB.stealthAddress, 401n))));
await run('BOND-30', 'DFABI redeem', 'happy', 'B 0, A 0, tranche supply 0', async () => {
  let tx = '';
  for (const [w, f, amount] of [[bondWalletB, bondFoundB, 400n], [bondWalletA, bondFoundA, 600n]] as const) {
    tx = await sendTx(as(bond, w).redeemByPartition(TRANCHE_A, amount, await redeemCert(f.stealthAddress, amount), { gasPrice }));
  }
  return { tx, actual: `B ${await bond.balanceOfByPartition(TRANCHE_A, bondFoundB.stealthAddress)}, A ${await bond.balanceOfByPartition(TRANCHE_A, bondFoundA.stealthAddress)}, tranche supply ${await bond.totalSupplyByPartition(TRANCHE_A)}` };
});
await run('BOND-31', 'DFABI controller', 'negative', 'revert (no data)', () => rev(as(bond, stranger).setDocument.staticCall(encodeBytes32String('X'), 'u', ZeroHash)));

// =====================================================================================================
// 4. Atomic DvP: DFABI bond against RD
// =====================================================================================================
const sellerBank = generateMetaAddress();
const buyerBank = generateMetaAddress();
const thirdBank = generateMetaAddress();
const sellerId = Wallet.createRandom();
const buyerId = Wallet.createRandom();
const T = 6n; // trades that need a funded seller and buyer
const forSeller = pay(sellerBank.metaAddress, DEPLOYER_KEY, bondAddr, BOND * T, TRANCHE_A);
const forBuyer = pay(buyerBank.metaAddress, DEPLOYER_KEY, rdAddr, PRICE * T);
await sendTx(bond.issueByPartitionStealth(...issueArgs(forSeller, BOND * T)));
await sendTx(rd.mintStealth(...mintArgs(forBuyer, PRICE * T)));
const [sellerFund] = scan(await announcements(bondAddr), sellerBank.viewKey, sellerBank.spendKey);
const [buyerFund] = scan(await announcements(rdAddr), buyerBank.viewKey, buyerBank.spendKey);
const sellerWallet = walletOf(sellerFund);
const buyerWallet = walletOf(buyerFund);
const thirdParty = fresh();

// A trade: terms and certificates are prepared first (the custodian signs for the predicted escrow address), then created.
async function prepare(ttl: bigint, o: { settleCertFor?: string } = {}) {
  const expiry = (await now()) + ttl;
  const bondPay = pay(buyerBank.metaAddress, sellerId.privateKey, bondAddr, BOND, TRANCHE_A);
  const rdPay = pay(sellerBank.metaAddress, buyerId.privateKey, rdAddr, PRICE);
  const terms = {
    tradeId: hexlify(randomBytes(32)),
    bond: bondAddr, partition: TRANCHE_A, bondAmount: BOND,
    rd: rdAddr, rdAmount: PRICE,
    seller: sellerFund.stealthAddress, buyer: buyerFund.stealthAddress,
    expiry, refundWindow: WINDOW,
    bondLeg: { receiver: bondPay.s.stealthAddress, ephemeralPubKey: bondPay.s.ephemeralPubKey, viewTag: bondPay.s.viewTag, memo: bondPay.memo },
    rdLeg: { receiver: rdPay.s.stealthAddress, ephemeralPubKey: rdPay.s.ephemeralPubKey, viewTag: rdPay.s.viewTag, memo: rdPay.memo },
  };
  const predicted: string = await factory.predict(terms);
  const settleArgs = [TRANCHE_A, terms.bondLeg.receiver, BOND, terms.bondLeg.ephemeralPubKey, terms.bondLeg.viewTag, terms.bondLeg.memo];
  const settleCert = await cert(xferFn, o.settleCertFor ?? predicted, settleArgs, { expiry });
  const refundCert = await cert('transferByPartition', predicted, [TRANCHE_A, terms.seller, BOND], { expiry: expiry + WINDOW });
  return { terms, predicted, settleCert, refundCert, expiry, bondPay, rdPay };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
const create = async (t: Prepared) => {
  const tx = await sendTx(factory.create(t.terms, t.settleCert, t.refundCert));
  return { tx, escrow: new Contract(t.predicted, artifact('DvPEscrow').abi, custodian) };
};
async function fundBond(escrow: string, amount = BOND) {
  const c = await cert('transferByPartition', sellerFund.stealthAddress, [TRANCHE_A, escrow, amount]);
  await sendTx(as(bond, sellerWallet).transferByPartition(TRANCHE_A, escrow, amount, c, { gasPrice }));
}
const fundRd = (escrow: string, amount = PRICE) => sendTx(as(rd, buyerWallet).transfer(escrow, amount, { gasPrice }));
const bondBal = (a: string) => bond.balanceOfByPartition(TRANCHE_A, a) as Promise<bigint>;
const rdBal = (a: string) => rd.balanceOf(a) as Promise<bigint>;

// ---- creation guards (nothing created yet) ----
const t1 = await prepare(600n);
await run('DVP-01', 'DvP factory.create', 'negative', 'OnlyCustodian', () => rev(as(factory, stranger).create.staticCall(t1.terms, t1.settleCert, t1.refundCert)));
await run('DVP-02', 'DvP factory.create', 'negative', 'OnlyCustodian', () => rev(as(factory, sellerWallet).create.staticCall(t1.terms, t1.settleCert, t1.refundCert))); // not even the seller
await run('DVP-03', 'DvP factory.create', 'negative', 'CertificateExpiresTooEarly', async () => // settle certificate expires before the trade
  rev(factory.create.staticCall(t1.terms, await cert(xferFn, t1.predicted, [TRANCHE_A, t1.terms.bondLeg.receiver, BOND, t1.terms.bondLeg.ephemeralPubKey, t1.terms.bondLeg.viewTag, t1.terms.bondLeg.memo], { expiry: t1.expiry - 1n }), t1.refundCert)));
await run('DVP-04', 'DvP factory.create', 'negative', 'CertificateExpiresTooEarly', async () => // refund certificate does not cover the refund window
  rev(factory.create.staticCall(t1.terms, t1.settleCert, await cert('transferByPartition', t1.predicted, [TRANCHE_A, t1.terms.seller, BOND], { expiry: t1.expiry + WINDOW - 1n }))));
await run('DVP-05', 'DvP factory.create', 'negative', 'BadCertificateLength', () => rev(factory.create.staticCall(t1.terms, t1.settleCert.slice(0, -2), t1.refundCert)));
await run('DVP-06', 'DvP factory.create', 'happy', 'escrow at the predicted address, certificatesSet', async () => {
  const { tx, escrow } = await create(t1);
  return { tx, actual: (await escrow.certificatesSet()) ? 'escrow at the predicted address, certificatesSet' : 'certificates not set' };
});
const e1 = new Contract(t1.predicted, artifact('DvPEscrow').abi, custodian);
await run('DVP-07', 'DvP factory.create', 'negative', 'revert (no data)', () => rev(factory.create.staticCall(t1.terms, t1.settleCert, t1.refundCert))); // same tradeId and terms: CREATE2 address is taken
await run('DVP-08', 'DvP escrow', 'negative', 'OnlyFactory', () => rev(as(e1, stranger).setCertificates.staticCall(t1.settleCert, t1.refundCert)));
await run('DVP-09', 'DvP escrow', 'negative', 'OnlyFactory', () => rev(e1.setCertificates.staticCall(t1.settleCert, t1.refundCert))); // not even the custodian, only the factory
await run('DVP-10', 'DvP funding', 'negative', '54', async () => // seller funding the bond leg without its own custodian certificate
  rev(as(bond, sellerWallet).transferByPartition.staticCall(TRANCHE_A, t1.predicted, BOND, '0x')));
await run('DVP-11', 'DvP settle', 'negative', 'NotFunded', () => rev(as(e1, thirdParty).settle.staticCall())); // nothing funded
await fundBond(t1.predicted);
await run('DVP-12', 'DvP settle', 'negative', 'NotFunded', () => rev(as(e1, thirdParty).settle.staticCall())); // only the bond leg is funded
await fundRd(t1.predicted);

// ---- trade 1: settled by a third party ----
await run('DVP-13', 'DvP settle', 'happy', 'bond to buyer receiver, RD to seller receiver, escrow empty, settled', async () => {
  const tx = await sendTx(as(e1, thirdParty).settle({ gasPrice }));
  const ok = (await bondBal(t1.terms.bondLeg.receiver)) === BOND && (await rdBal(t1.terms.rdLeg.receiver)) === PRICE
    && (await bondBal(t1.predicted)) === 0n && (await rdBal(t1.predicted)) === 0n && (await e1.settled()) === true;
  return { tx, actual: ok ? 'bond to buyer receiver, RD to seller receiver, escrow empty, settled' : 'unexpected balances' };
});
await run('DVP-14', 'DvP settle', 'negative', 'AlreadySettled', () => rev(as(e1, thirdParty).settle.staticCall()));
await run('DVP-15', 'DvP cancel', 'negative', 'AlreadySettled', () => rev(as(e1, thirdParty).cancel.staticCall()));

// ---- trade 1 visibility ----
const annsRdAfter = await announcements(rdAddr);
const annsBondAfter = await announcements(bondAddr);
const bondLegAnn = annsBondAfter.find((a) => a.stealthAddress === t1.terms.bondLeg.receiver)!;
const rdLegAnn = annsRdAfter.find((a) => a.stealthAddress === t1.terms.rdLeg.receiver)!;
const holdersTrade: ViewKeyHolder[] = [
  { id: 'seller-bank', viewKey: sellerBank.viewKey, metaAddress: sellerBank.metaAddress },
  { id: 'buyer-bank', viewKey: buyerBank.viewKey, metaAddress: buyerBank.metaAddress },
];
await run('DVP-16', 'BI view-key scan (DvP)', 'happy', `bond leg: buyer-bank:${BOND}:${sellerId.address}; RD leg: seller-bank:${PRICE}:${buyerId.address}`, async () => {
  const b = scanAll([bondLegAnn], holdersTrade)[0];
  const r = scanAll([rdLegAnn], holdersTrade)[0];
  const bp = read(b.announcement, holdersTrade.find((h) => h.id === b.bank)!.viewKey, 'bond');
  const rp = read(r.announcement, holdersTrade.find((h) => h.id === r.bank)!.viewKey, 'rd');
  return `bond leg: ${b.bank}:${bp.amount}:${bp.sender}; RD leg: ${r.bank}:${rp.amount}:${rp.sender}`;
});
await run('DVP-17', 'DvP visibility', 'happy', 'seller and buyer each find their receiving address; escrow terms show both receivers', async () => {
  const [sellerGot] = scan([rdLegAnn], sellerBank.viewKey, sellerBank.spendKey);
  const [buyerGot] = scan([bondLegAnn], buyerBank.viewKey, buyerBank.spendKey);
  const onChain = await e1.getTerms();
  return sellerGot?.stealthAddress === t1.terms.rdLeg.receiver && buyerGot?.stealthAddress === t1.terms.bondLeg.receiver
    && onChain.bondLeg.receiver === buyerGot.stealthAddress && onChain.rdLeg.receiver === sellerGot.stealthAddress
    ? 'seller and buyer each find their receiving address; escrow terms show both receivers' : 'a party did not find its receiver';
});
await run('DVP-18', 'DvP visibility', 'negative', 'third bank resolves 0 legs and reads 0 memos', async () => {
  const third: ViewKeyHolder[] = [{ id: 'third-bank', viewKey: thirdBank.viewKey, metaAddress: thirdBank.metaAddress }];
  const bp = read(bondLegAnn, thirdBank.viewKey, 'bond');
  const rp = read(rdLegAnn, thirdBank.viewKey, 'rd');
  return `third bank resolves ${scanAll([bondLegAnn, rdLegAnn], third).length} legs and reads ${[bp.sender, rp.sender].filter(Boolean).length} memos`;
});

// ---- trades 2-6: all expire in about the same minute; each gets its negative checks before expiry ----
const TTL = 100n;
const t2 = await prepare(TTL); // both legs funded, never settled
const t3 = await prepare(TTL); // bond leg only
const t4 = await prepare(TTL); // RD leg only, one unit short
const t5 = await prepare(TTL); // nothing funded
const t6 = await prepare(TTL, { settleCertFor: randomAddress() }); // both funded, settle certificate is for another address
const mk = async (t: Prepared) => (await create(t)).escrow;
const [e2, e3, e4, e5, e6] = [await mk(t2), await mk(t3), await mk(t4), await mk(t5), await mk(t6)];
await fundBond(t2.predicted); await fundRd(t2.predicted);
await fundBond(t3.predicted);
await fundRd(t4.predicted, PRICE - 1n);
await fundBond(t6.predicted); await fundRd(t6.predicted);
await run('DVP-19', 'DvP cancel', 'negative', 'NotExpired', () => rev(as(e2, thirdParty).cancel.staticCall())); // cancel before expiry
await run('DVP-20', 'DvP settle', 'negative', 'NotFunded', () => rev(as(e3, thirdParty).settle.staticCall())); // RD leg missing
await run('DVP-21', 'DvP settle', 'negative', 'NotFunded', () => rev(as(e4, thirdParty).settle.staticCall())); // bond leg missing and RD one unit short
await run('DVP-22', 'DvP settle', 'negative', 'NotFunded', () => rev(as(e5, thirdParty).settle.staticCall())); // nothing funded
await run('DVP-23', 'DvP settle', 'negative', '54', async () => rev(as(e6, thirdParty).settle.staticCall())); // the bond leg's certificate is for another address
await run('DVP-24', 'DvP settle', 'negative', 'RD still in escrow, bond still in escrow', async () => { // the failed settle (staticCall) moved nothing; check the real state
  return `${(await rdBal(t6.predicted)) === PRICE ? 'RD still in escrow' : 'RD moved'}, ${(await bondBal(t6.predicted)) === BOND ? 'bond still in escrow' : 'bond moved'}`;
});

await waitUntil(t2.expiry);
for (const t of [t3, t4, t5, t6]) await waitUntil(t.expiry);
await run('DVP-25', 'DvP settle', 'negative', 'Expired', () => rev(as(e2, thirdParty).settle.staticCall())); // both legs funded, but too late
const sBefore = await bondBal(sellerFund.stealthAddress);
const bRdBefore = await rdBal(buyerFund.stealthAddress);
await run('DVP-26', 'DvP cancel (both legs)', 'happy', `seller +${BOND} bond, buyer +${PRICE} RD, escrow empty (caller gets nothing)`, async () => {
  const tx = await sendTx(as(e2, thirdParty).cancel({ gasPrice }));
  const ok = (await bondBal(t2.predicted)) === 0n && (await rdBal(t2.predicted)) === 0n && (await bondBal(thirdParty.address)) === 0n && (await rdBal(thirdParty.address)) === 0n;
  return { tx, actual: `seller +${(await bondBal(sellerFund.stealthAddress)) - sBefore} bond, buyer +${(await rdBal(buyerFund.stealthAddress)) - bRdBefore} RD, escrow ${ok ? 'empty (caller gets nothing)' : 'not empty or caller paid'}` };
});
await run('DVP-27', 'DvP cancel', 'negative', 'NothingToRefund', () => rev(as(e2, thirdParty).cancel.staticCall())); // second cancel
await run('DVP-28', 'DvP cancel (bond leg only)', 'happy', `seller +${BOND} bond, buyer +0 RD`, async () => {
  const s0 = await bondBal(sellerFund.stealthAddress); const r0 = await rdBal(buyerFund.stealthAddress);
  const tx = await sendTx(as(e3, thirdParty).cancel({ gasPrice }));
  return { tx, actual: `seller +${(await bondBal(sellerFund.stealthAddress)) - s0} bond, buyer +${(await rdBal(buyerFund.stealthAddress)) - r0} RD` };
});
await run('DVP-29', 'DvP cancel (RD leg only)', 'happy', `seller +0 bond, buyer +${PRICE - 1n} RD`, async () => {
  const s0 = await bondBal(sellerFund.stealthAddress); const r0 = await rdBal(buyerFund.stealthAddress);
  const tx = await sendTx(as(e4, thirdParty).cancel({ gasPrice }));
  return { tx, actual: `seller +${(await bondBal(sellerFund.stealthAddress)) - s0} bond, buyer +${(await rdBal(buyerFund.stealthAddress)) - r0} RD` };
});
await run('DVP-30', 'DvP cancel', 'negative', 'NothingToRefund', () => rev(as(e5, thirdParty).cancel.staticCall())); // nothing was funded
await run('DVP-31', 'DvP cancel (bad settle certificate)', 'happy', `seller +${BOND} bond, buyer +${PRICE} RD`, async () => { // the refund certificate is separate and valid
  const s0 = await bondBal(sellerFund.stealthAddress); const r0 = await rdBal(buyerFund.stealthAddress);
  const tx = await sendTx(as(e6, thirdParty).cancel({ gasPrice }));
  return { tx, actual: `seller +${(await bondBal(sellerFund.stealthAddress)) - s0} bond, buyer +${(await rdBal(buyerFund.stealthAddress)) - r0} RD` };
});

// =====================================================================================================
// 5. Instrument registry: register, registerVersion, read back, hash check
// =====================================================================================================
const F_INS = 'InstrumentRegistry';
const sample = (f: string) => JSON.parse(readFileSync(`docs/samples/${f}`, 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const rdRecord = sample('rd.sample.json');
rdRecord.extensions.cash.token = rdAddr;
const bondRecord = sample('dfabi-bdt-v1.2.sample.json');
bondRecord.bdt.dlt_platform_information_smart_contract = bondAddr;
const uri = (r: any, token: string) => `https://example.invalid/instruments/${r.kind}-${token}.json`;
const ra = (r: unknown) => registrationArgs(r);
const dfabiBdt = (path: string, value: unknown) => { const r = clone(bondRecord); r.bdt[path] = value; return r; };

await run('INS-01', F_INS + ' (validator)', 'happy', 'RD valid, DFABI valid', async () =>
  `RD ${validateRecord(rdRecord).valid ? 'valid' : 'invalid'}, DFABI ${validateRecord(bondRecord).valid ? 'valid' : 'invalid'}`);
for (const [n, token, record, primary] of [['02', rdAddr, rdRecord, 'IDR'], ['03', bondAddr, bondRecord, 'IDDFA0000013']] as const) {
  await run(`INS-${n}`, F_INS + ` register ${record.kind}`, 'happy', OK, async () => {
    const a = ra(record);
    const tx = await sendTx(instruments.register(token, a.kind, a.profileVersion, a.primaryId, a.dataHash, uri(record, token)));
    const s = await instruments.getInstrument(token);
    return { tx, actual: verify(
      ['token, kind, version, primary id, uri, registrant', s.token === token && s.kind === encodeBytes32String(record.kind) && s.version === 1n && s.primaryId === primary && s.dataUri === uri(record, token) && s.registrant === custodian.address],
      ['stored hash equals keccak256(canonical JSON) recomputed from the record', s.dataHash === keccak256(toUtf8Bytes(canonicalJson(clone(record)))) && s.dataHash === recordHash(record)],
      ['one version', (await instruments.versionCount(token)) === 1n], ['isRegistered', (await instruments.isRegistered(token)) === true]) };
  });
}
await run('INS-04', F_INS + ' ERC-1400 document', 'happy', 'getDocument returns the same uri and hash', async () => {
  const docHash = recordHash(bondRecord);
  const tx = await sendTx(bond.setDocument(encodeBytes32String('ICMA-BDT-v1.2'), uri(bondRecord, bondAddr), docHash));
  const [u, h] = await bond.getDocument(encodeBytes32String('ICMA-BDT-v1.2'));
  return { tx, actual: u === uri(bondRecord, bondAddr) && h === docHash ? 'getDocument returns the same uri and hash' : 'document differs' };
});
const corrected = dfabiBdt('amounts_tranche_amount', '400000000000');
await run('INS-05', F_INS + ' registerVersion', 'happy', 'version 2 is the correction, version 1 unchanged', async () => {
  const a = ra(corrected);
  const tx = await sendTx(instruments.registerVersion(bondAddr, a.kind, a.profileVersion, a.primaryId, a.dataHash, uri(corrected, bondAddr) + '?v=2'));
  const ok = (await instruments.versionCount(bondAddr)) === 2n && (await instruments.getInstrument(bondAddr)).dataHash === recordHash(corrected)
    && (await instruments.getInstrumentVersion(bondAddr, 1n)).dataHash === recordHash(bondRecord);
  return { tx, actual: ok ? 'version 2 is the correction, version 1 unchanged' : 'versions differ from expected' };
});
const shuffled = (v: any): any => (Array.isArray(v) ? v.map(shuffled) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffled(x)])) : v);
await run('INS-06', F_INS + ' hash', 'happy', 'same hash with reversed key order', async () =>
  recordHash(shuffled(bondRecord)) === (await instruments.getInstrumentVersion(bondAddr, 1n)).dataHash ? 'same hash with reversed key order' : 'hash depends on key order');
await run('INS-07', F_INS + ' hash', 'negative', 'a tampered off-chain record no longer matches the stored hash', async () =>
  recordHash(dfabiBdt('amounts_tranche_amount', '1')) !== (await instruments.getInstrumentVersion(bondAddr, 1n)).dataHash ? 'a tampered off-chain record no longer matches the stored hash' : 'tampering undetected');
const a0 = ra(rdRecord);
const regArgs = (token: string, a = a0, u = 'https://example.invalid/x') => [token, a.kind, a.profileVersion, a.primaryId, a.dataHash, u] as const;
await run('INS-08', F_INS + ' register', 'negative', 'AlreadyRegistered', () => rev(instruments.register.staticCall(...regArgs(rdAddr))));
await run('INS-09', F_INS + ' register', 'negative', 'NotRegistrar', () => rev(as(instruments, stranger).register.staticCall(...regArgs(randomAddress()))));
await run('INS-10', F_INS + ' registerVersion', 'negative', 'NotRegistrar', () => rev(as(instruments, stranger).registerVersion.staticCall(...regArgs(rdAddr))));
await run('INS-11', F_INS + ' registerVersion', 'negative', 'NotRegisteredYet', () => rev(instruments.registerVersion.staticCall(...regArgs(randomAddress()))));
await run('INS-12', F_INS + ' registerVersion', 'negative', 'IdentityChanged', () => rev(instruments.registerVersion.staticCall(rdAddr, a0.kind, a0.profileVersion, 'IDR2', a0.dataHash, 'u'))); // other primary id
await run('INS-13', F_INS + ' registerVersion', 'negative', 'IdentityChanged', () => rev(instruments.registerVersion.staticCall(rdAddr, ra(bondRecord).kind, a0.profileVersion, a0.primaryId, a0.dataHash, 'u'))); // other kind
const fresh1 = randomAddress();
await run('INS-14', F_INS + ' register', 'negative', 'EmptyInput', () => rev(instruments.register.staticCall(fresh1, a0.kind, a0.profileVersion, a0.primaryId, a0.dataHash, '')));
await run('INS-15', F_INS + ' register', 'negative', 'EmptyInput', () => rev(instruments.register.staticCall(fresh1, a0.kind, a0.profileVersion, '', a0.dataHash, 'u')));
await run('INS-16', F_INS + ' register', 'negative', 'EmptyInput', () => rev(instruments.register.staticCall(fresh1, a0.kind, a0.profileVersion, a0.primaryId, ZeroHash, 'u')));
await run('INS-17', F_INS + ' register', 'negative', 'EmptyInput', () => rev(instruments.register.staticCall(ZeroAddress, a0.kind, a0.profileVersion, a0.primaryId, a0.dataHash, 'u')));
await run('INS-18', F_INS + ' register', 'negative', 'EmptyInput', () => rev(instruments.register.staticCall(fresh1, ZeroHash, a0.profileVersion, a0.primaryId, a0.dataHash, 'u')));
await run('INS-19', F_INS + ' read', 'negative', 'UnknownInstrument', () => rev(instruments.getInstrument.staticCall(randomAddress())));
await run('INS-20', F_INS + ' read', 'negative', 'UnknownInstrument / UnknownInstrument', async () => `${await rev(instruments.getInstrumentVersion.staticCall(rdAddr, 0n))} / ${await rev(instruments.getInstrumentVersion.staticCall(rdAddr, 2n))}`);
await run('INS-21', F_INS + ' setRegistrar', 'negative', 'NotOwner', () => rev(as(instruments, stranger).setRegistrar.staticCall(stranger.address, true)));
await run('INS-22', F_INS + ' transferOwnership', 'negative', 'NotOwner', () => rev(as(instruments, stranger).transferOwnership.staticCall(stranger.address)));
await run('INS-23', F_INS + ' transferOwnership', 'negative', 'EmptyInput', () => rev(instruments.transferOwnership.staticCall(ZeroAddress)));
await run('INS-24', F_INS + ' setRegistrar', 'happy', 'granted registrar registers a new token, revoked registrar is refused again', async () => {
  await sendTx(instruments.setRegistrar(stranger.address, true));
  const tx = await sendTx(as(instruments, stranger).register(...regArgs(fresh1), { gasPrice }));
  await sendTx(instruments.setRegistrar(stranger.address, false));
  const after = await rev(as(instruments, stranger).register.staticCall(...regArgs(randomAddress())));
  return { tx, actual: (await instruments.isRegistered(fresh1)) && after === 'NotRegistrar' ? 'granted registrar registers a new token, revoked registrar is refused again' : `after revoke: ${after}` };
});
// Record validation: exact messages.
const errorsOf = (r: unknown) => validateRecord(r).errors.join(' ; ');
await run('INS-25', F_INS + ' (validator)', 'negative', 'bdt.security_identifier_and_status_identifier_value: "IDDFA0000014" is not a valid ISIN (ISO 6166 check digit)', async () =>
  errorsOf(dfabiBdt('security_identifier_and_status_identifier_value', ['IDDFA0000014'])));
await run('INS-26', F_INS + ' (validator)', 'negative', 'bdt.issuer_issuer_lei: "TEST00FICTIVE0000146" is not a valid LEI (ISO 17442 mod-97)', async () =>
  errorsOf(dfabiBdt('issuer_issuer_lei', 'TEST00FICTIVE0000146')));
await run('INS-27', F_INS + ' (validator)', 'negative', 'bdt.dates_issue_date is required', async () => {
  const r = clone(bondRecord);
  delete r.bdt.dates_issue_date;
  return errorsOf(r);
});
await run('INS-28', F_INS + ' (validator)', 'negative', 'bdt.dates_pricing_date is not allowed here', async () => // forbidden unless the series is auctioned
  errorsOf(dfabiBdt('listing_and_restrictions_method_of_distribution', 'Syndicated')));
await run('INS-29', F_INS + ' (validator)', 'negative', 'bdt.issuer_issuer_name is not used by profile RD', async () => {
  const r = clone(rdRecord);
  r.bdt = { issuer_issuer_name: 'X' };
  return errorsOf(r);
});
await run('INS-30', F_INS + ' (validator)', 'negative', 'bdt.currency_specified_currency: "USD" must be one of IDR', async () => errorsOf(dfabiBdt('currency_specified_currency', 'USD')));
await run('INS-31', F_INS + ' (validator)', 'negative', 'bdt.amounts_tranche_amount must be a non-empty string', async () => errorsOf(dfabiBdt('amounts_tranche_amount', 5)));
await run('INS-32', F_INS + ' (validator)', 'negative', 'kind "XYZ" has no profile', async () => errorsOf({ ...clone(bondRecord), kind: 'XYZ' }));
await run('INS-33', F_INS + ' (validator)', 'negative', 'schema must be "rd-dfabi-instrument/1"', async () => errorsOf({ ...clone(bondRecord), schema: 'x' }));
await run('INS-34', F_INS + ' (validator)', 'negative', 'bdt.not_a_field is not a catalog field', async () => errorsOf(dfabiBdt('not_a_field', 'x')));
await run('INS-35', F_INS + ' registrationArgs', 'negative', 'invalid instrument record: bdt.dates_issue_date is required', () => {
  const r = clone(bondRecord);
  delete r.bdt.dates_issue_date;
  return thrown(() => registrationArgs(r));
});
await run('INS-36', F_INS + ' profiles', 'happy', 'RD profile uses 0 BDT fields, DFABI profile uses 59', async () =>
  `RD profile uses ${Object.keys(loadProfile('RD')!.bdt).length} BDT fields, DFABI profile uses ${Object.keys(loadProfile('DFABI')!.bdt).length}`);

// ---------- totals ----------
const count = (kind: Row['kind']) => ({ pass: rows.filter((r) => r.kind === kind && r.ok).length, total: rows.filter((r) => r.kind === kind).length });
const [h, n] = [count('happy'), count('negative')];
const fails = rows.filter((r) => !r.ok);
console.log(`\nTOTAL happy ${h.pass}/${h.total} | negative ${n.pass}/${n.total} | FAIL ${fails.length}`);
for (const f of fails) console.log(`FAIL ${f.id}: expected "${f.expected}" got "${f.actual}"`);

const mdPath = process.argv[process.argv.indexOf('--md') + 1];
if (process.argv.includes('--md') && mdPath) {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines = ['| ID | Feature | Type | Expected | Actual | Result | Tx |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.id} | ${esc(r.feature)} | ${r.kind} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.tx === '-' ? '-' : '`' + r.tx.slice(0, 18) + '…`'} |`);
  writeFileSync(mdPath, lines.join('\n') + `\n\nTotals: happy ${h.pass}/${h.total}, negative ${n.pass}/${n.total}.\n`);
}
process.exit(fails.length ? 1 : 0);
