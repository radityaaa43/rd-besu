// One-off DvP smoke check (DFABI bond against RD) on a live Besu network. Not part of CI.
// Needs the ERC1820 registry (node script/deploy-erc1820.ts).
// Usage: forge build && set -a && . ./.env.smoke && set +a && node script/smoke-dvp.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, Interface, JsonRpcProvider, Wallet, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { CERTIFICATE_LENGTH, parseBondMetadata, payloadWithoutCertificate, signCertificate } from '../ts/bond.ts';
import { buildMemo, openMemo } from '../ts/memo.ts';
import { deriveStealth, generateMetaAddress, scan, scanAll, type Announcement } from '../ts/stealth.ts';
import { parseTokenMetadata } from '../ts/token.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
// The deployer plays BI (RD issuer), the custodian (bond minter, controller, certificate signer, escrow creator) and any third party.
const custodian = new Wallet(DEPLOYER_KEY, provider);
const TRANCHE_A = encodeBytes32String('TRANCHE-A');
const BOND = 1000n;
const PRICE = 5_000_000n;
const WINDOW = 600n;

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('FAILED: ' + msg);
}
const artifact = (name: string) => JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
async function deploy(name: string, ...args: unknown[]): Promise<Contract> {
  const { abi, bytecode } = artifact(name);
  const c = await new ContractFactory(abi, bytecode.object, custodian).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = async () => BigInt((await provider.getBlock('latest'))!.timestamp);
async function waitUntil(ts: bigint) {
  while ((await now()) < ts) {
    await (await custodian.sendTransaction({ to: custodian.address, value: 0 })).wait(); // keep blocks coming
    await sleep(2000);
  }
}

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());
check((await provider.getCode('0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24')) !== '0x', 'ERC1820 registry is deployed');

const fromBlock = await provider.getBlockNumber();
const announcer = await deploy('ERC5564Announcer');
const validator = await deploy('ERC1400TokensValidator');
const bond = await deploy('DfabiBond', 'DFABI Series 1', 'DFB1', [custodian.address], [TRANCHE_A], await announcer.getAddress());
const bondAddr = await bond.getAddress();
const rd = await deploy('RupiahDigital', custodian.address, await announcer.getAddress());
const rdAddr = await rd.getAddress();
const factory = await deploy('DvPFactory', custodian.address);
console.log('announcer', await announcer.getAddress(), '| bond', bondAddr, '| rd', rdAddr, '| factory', await factory.getAddress());
for (const send of [
  () => bond.setTokenExtension(validator.target, 'ERC1400TokensValidator', true, false, false),
  () => validator.registerTokenSetup(bondAddr, 1, true, false, false, false, []),
  () => validator.addCertificateSigner(bondAddr, custodian.address),
  () => validator.addAllowlisted(bondAddr, custodian.address),
]) await (await send()).wait();

// The custodian signs the calldata of the exact call `msgSender` will make, minus the certificate argument.
async function certificate(fn: string, msgSender: string, args: unknown[], expiry: bigint): Promise<string> {
  const placeholder = bond.interface.encodeFunctionData(fn, [...args, new Uint8Array(CERTIFICATE_LENGTH)]);
  return signCertificate(DEPLOYER_KEY!, {
    domainSeparator: await bond.generateDomainSeparator(),
    msgSender,
    token: bondAddr,
    payload: payloadWithoutCertificate(placeholder),
    expiry,
    nonce: await validator.usedCertificateNonce(bondAddr, msgSender),
  });
}

async function announcements(token: string): Promise<Announcement[]> {
  const logs = await announcer.queryFilter(announcer.filters.Announcement(null, null, token), fromBlock);
  return logs.map((l: any) => ({ schemeId: l.args.schemeId, stealthAddress: l.args.stealthAddress, ephemeralPubKey: l.args.ephemeralPubKey, metadata: l.args.metadata }));
}

// Two banks and a third that takes no part. Each bank has a view key (BI and the custodian hold them) and an identity key.
const sellerBank = generateMetaAddress();
const buyerBank = generateMetaAddress();
const thirdBank = generateMetaAddress();
const sellerId = Wallet.createRandom();
const buyerId = Wallet.createRandom();
const holders = [
  { id: 'seller-bank', viewKey: sellerBank.viewKey, metaAddress: sellerBank.metaAddress },
  { id: 'buyer-bank', viewKey: buyerBank.viewKey, metaAddress: buyerBank.metaAddress },
];

// A payment to `meta` with its memo, signed by `senderKey`.
function pay(meta: string, senderKey: string, token: string, amount: bigint, partition?: string) {
  const ephemeralKey = hexlify(randomBytes(32));
  const s = deriveStealth(meta, ephemeralKey);
  const ctx = { chainId: net.chainId, token, stealthAddress: s.stealthAddress, amount, ephemeralPubKey: s.ephemeralPubKey, partition };
  return { s, ctx, memo: buildMemo({ senderKey, ephemeralKey, receiverMetaAddress: meta, ctx }) };
}

// 0. BI mints the buyer its RD, the custodian issues the seller its bond; each bank scans for its funding address.
const forBuyer = pay(buyerBank.metaAddress, DEPLOYER_KEY, rdAddr, PRICE * 2n);
await (await rd.mintStealth(forBuyer.s.stealthAddress, PRICE * 2n, forBuyer.s.ephemeralPubKey, forBuyer.s.viewTag, forBuyer.memo)).wait();
const forSeller = pay(sellerBank.metaAddress, DEPLOYER_KEY, bondAddr, BOND * 2n, TRANCHE_A);
await (await bond.issueByPartitionStealth(TRANCHE_A, forSeller.s.stealthAddress, BOND * 2n, forSeller.s.ephemeralPubKey, forSeller.s.viewTag, forSeller.memo)).wait();
const [sellerFund] = scan(await announcements(bondAddr), sellerBank.viewKey, sellerBank.spendKey);
const [buyerFund] = scan(await announcements(rdAddr), buyerBank.viewKey, buyerBank.spendKey);
check(sellerFund && buyerFund, 'banks found their funding addresses');
const sellerWallet = new Wallet(sellerFund.privateKey, provider);
const buyerWallet = new Wallet(buyerFund.privateKey, provider);

// One trade: build terms, custodian pre-signs for the predicted escrow address, creates it, both sides fund.
async function openTrade(ttl: bigint) {
  const t0 = await now();
  const expiry = t0 + ttl;
  const bondPay = pay(buyerBank.metaAddress, sellerId.privateKey, bondAddr, BOND, TRANCHE_A); // buyer's fresh address, memo from the seller
  const rdPay = pay(sellerBank.metaAddress, buyerId.privateKey, rdAddr, PRICE); // seller's fresh address, memo from the buyer
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
  const settleCert = await certificate('transferByPartitionStealth', predicted, [TRANCHE_A, terms.bondLeg.receiver, BOND, terms.bondLeg.ephemeralPubKey, terms.bondLeg.viewTag, terms.bondLeg.memo], expiry);
  const refundCert = await certificate('transferByPartition', predicted, [TRANCHE_A, terms.seller, BOND], expiry + WINDOW);
  await (await factory.create(terms, settleCert, refundCert)).wait();
  const escrow = new Contract(predicted, artifact('DvPEscrow').abi, custodian);
  check((await escrow.certificatesSet()) === true, 'escrow created with certificates at the predicted address');

  // Seller funds the bond leg with its own custodian certificate, buyer funds the RD leg. Both from unfunded stealth addresses.
  const fundCert = await certificate('transferByPartition', sellerFund.stealthAddress, [TRANCHE_A, predicted, BOND], (await now()) + 600n);
  await (await bond.connect(sellerWallet).getFunction('transferByPartition')(TRANCHE_A, predicted, BOND, fundCert, { gasPrice })).wait();
  await (await rd.connect(buyerWallet).getFunction('transfer')(predicted, PRICE, { gasPrice })).wait();
  return { escrow, predicted, terms, bondPay, rdPay, expiry };
}

// ---- Trade 1: settled by a third party ----
const t1 = await openTrade(300n);
check((await bond.balanceOfByPartition(TRANCHE_A, t1.predicted)) === BOND && (await rd.balanceOf(t1.predicted)) === PRICE, 'trade 1 escrow holds both legs');
const thirdParty = Wallet.createRandom().connect(provider); // never funded, gas price 0
const settleTx = await (await t1.escrow.connect(thirdParty).getFunction('settle')({ gasPrice })).wait();
console.log('SETTLE tx', settleTx.hash);
check((await bond.balanceOfByPartition(TRANCHE_A, t1.terms.bondLeg.receiver)) === BOND, "buyer's fresh address holds the bond");
check((await rd.balanceOf(t1.terms.rdLeg.receiver)) === PRICE, "seller's fresh address holds the RD");
check((await bond.balanceOfByPartition(TRANCHE_A, t1.predicted)) === 0n && (await rd.balanceOf(t1.predicted)) === 0n, 'escrow is empty');
check((await t1.escrow.settled()) === true, 'settled flag');

// ---- Trade 2: nobody settles; it expires and a third party cancels ----
const t2 = await openTrade(25n);
await waitUntil(t2.expiry);
const cancelTx = await (await t2.escrow.connect(thirdParty).getFunction('cancel')({ gasPrice })).wait();
console.log('CANCEL tx', cancelTx.hash);
check((await bond.balanceOfByPartition(TRANCHE_A, sellerFund.stealthAddress)) === BOND, 'seller got the unsold bond back (trade 2)');
check((await rd.balanceOf(buyerFund.stealthAddress)) === PRICE * 2n - PRICE, 'buyer got the RD back (trade 2); trade 1 price is gone');
check((await bond.balanceOfByPartition(TRANCHE_A, t2.predicted)) === 0n && (await rd.balanceOf(t2.predicted)) === 0n, 'escrow 2 is empty');

// ---- Visibility of trade 1 ----
const bondAnns = await announcements(bondAddr);
const rdAnns = await announcements(rdAddr);
const bondLegAnn = bondAnns.find((a) => a.stealthAddress === t1.terms.bondLeg.receiver)!;
const rdLegAnn = rdAnns.find((a) => a.stealthAddress === t1.terms.rdLeg.receiver)!;
const bm = parseBondMetadata(bondLegAnn.metadata)!;
const rm = parseTokenMetadata(rdLegAnn.metadata)!;
check(bm.token === bondAddr && bm.amount === BOND && bm.partition === TRANCHE_A, 'bond leg metadata: token, amount, tranche');
check(rm.token === rdAddr && rm.amount === PRICE, 'RD leg metadata: token, amount');
const openBond = (viewKey: string) => openMemo(bm.memo, viewKey, { chainId: net.chainId, token: bm.token, stealthAddress: bondLegAnn.stealthAddress, amount: bm.amount, ephemeralPubKey: bondLegAnn.ephemeralPubKey, partition: bm.partition });
const openRd = (viewKey: string) => openMemo(rm.memo, viewKey, { chainId: net.chainId, token: rm.token, stealthAddress: rdLegAnn.stealthAddress, amount: rm.amount, ephemeralPubKey: rdLegAnn.ephemeralPubKey });

// BI (holding every bank's view key) resolves both receivers to banks and reads both memos.
const biBond = scanAll([bondLegAnn], holders);
const biRd = scanAll([rdLegAnn], holders);
check(biBond.length === 1 && biBond[0].bank === 'buyer-bank', 'BI: the bond receiver is the buyer bank');
check(biRd.length === 1 && biRd[0].bank === 'seller-bank', 'BI: the RD receiver is the seller bank');
check(openBond(buyerBank.viewKey)?.sender === sellerId.address, 'BI/buyer: bond memo says the seller sent it');
check(openRd(sellerBank.viewKey)?.sender === buyerId.address, 'BI/seller: RD memo says the buyer paid it');
// The seller sees the trade it received (RD from the buyer) and the escrow terms it built; the buyer the mirror image.
const [sellerGot] = scan([rdLegAnn], sellerBank.viewKey, sellerBank.spendKey);
const [buyerGot] = scan([bondLegAnn], buyerBank.viewKey, buyerBank.spendKey);
check(sellerGot?.stealthAddress === t1.terms.rdLeg.receiver && buyerGot?.stealthAddress === t1.terms.bondLeg.receiver, 'seller and buyer each find their receiving address');
const onChain = await t1.escrow.getTerms();
check(onChain.bondLeg.receiver === buyerGot.stealthAddress && onChain.rdLeg.receiver === sellerGot.stealthAddress, 'the escrow terms show both receivers to both sides');
// A third bank resolves nothing and decrypts nothing.
const third = [{ id: 'third-bank', viewKey: thirdBank.viewKey, metaAddress: thirdBank.metaAddress }];
check(scanAll([bondLegAnn, rdLegAnn], third).length === 0, 'a third bank resolves neither receiver');
check(openBond(thirdBank.viewKey) === null && openRd(thirdBank.viewKey) === null, 'a third bank cannot read either memo');

console.log('OK: DvP escrow, certified funding, settle by a third party, expiry + cancel with refunds, BI/seller/buyer see the trade, a third bank sees nothing');
process.exit(0);
