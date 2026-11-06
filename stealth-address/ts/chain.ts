// Chain helpers shared by script/e2e.ts and the Lensa Privasi stealth adapter, moved verbatim out of e2e.ts and
// parameterised: every provider, signer, address and chain id is an argument, there are no module globals.
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, Wallet, encodeBytes32String, hexlify, randomBytes, type ContractRunner, type Provider } from 'ethers';
import { CERTIFICATE_LENGTH, parseBondMetadata, payloadWithoutCertificate, signCertificate } from './bond.ts';
import { buildMemo, openMemo, type MemoContext } from './memo.ts';
import { deriveStealth, scanAll, type Announcement, type ViewKeyHolder } from './stealth.ts';
import { parseTokenMetadata } from './token.ts';

// Server code must not import ethers itself: it takes what it needs from here, so one ethers copy is in play.
export { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet } from 'ethers';
export type { Provider } from 'ethers';

export const TRANCHE_A = encodeBytes32String('TRANCHE-A');
export const LOG_RANGE = 1000; // Besu rejects eth_getLogs spans of 5000 blocks (-32005); 1000 is accepted

export type Deployed = {
  announcer: string; registry: string; validator: string; bond: string; rd: string; dvpFactory: string; instrumentRegistry: string;
  fromBlock: number; // block just before the deploy: announcements are read from here on
};

// out/ is resolved from this file, not from the cwd: the lensa server runs from another directory.
const OUT = new URL('../out/', import.meta.url);
export const artifact = (name: string, file = name) => JSON.parse(readFileSync(new URL(`${file}.sol/${name}.json`, OUT), 'utf8'));

export async function deploy(deployer: Wallet, name: string, args: unknown[] = [], file = name): Promise<Contract> {
  const { abi, bytecode } = artifact(name, file);
  const c = await new ContractFactory(abi, bytecode.object, deployer).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

// The deployer plays BI: RD issuer, bond minter and controller, certificate signer, escrow creator, registry owner and registrar.
export async function deployAll(deployer: Wallet): Promise<Deployed> {
  const fromBlock = await deployer.provider!.getBlockNumber(); // Besu caps the eth_getLogs range: read from just before the deploy
  const announcer = await deploy(deployer, 'ERC5564Announcer');
  const registry = await deploy(deployer, 'ERC6538Registry');
  const validator = await deploy(deployer, 'ERC1400TokensValidator');
  const bond = await deploy(deployer, 'DfabiBond', ['DFABI Series 1', 'DFB1', [deployer.address], [TRANCHE_A], await announcer.getAddress()]);
  const rd = await deploy(deployer, 'RupiahDigital', [deployer.address, await announcer.getAddress()]);
  const factory = await deploy(deployer, 'DvPFactory', [deployer.address]);
  const instruments = await deploy(deployer, 'InstrumentRegistry');
  const [announcerAddr, registryAddr, validatorAddr, bondAddr, rdAddr, factoryAddr, instrumentsAddr] = await Promise.all(
    [announcer, registry, validator, bond, rd, factory, instruments].map((c) => c.getAddress()),
  );
  for (const send of [
    () => bond.setTokenExtension(validator.target, 'ERC1400TokensValidator', true, false, false),
    () => validator.registerTokenSetup(bondAddr, 1, true, false, false, false, []),
    () => validator.addCertificateSigner(bondAddr, deployer.address),
    () => validator.addAllowlisted(bondAddr, deployer.address),
    () => instruments.setRegistrar(deployer.address, true),
  ]) await (await send()).wait();
  return {
    announcer: announcerAddr, registry: registryAddr, validator: validatorAddr, bond: bondAddr, rd: rdAddr,
    dvpFactory: factoryAddr, instrumentRegistry: instrumentsAddr, fromBlock,
  };
}

// The deployed contracts, bound to `runner` (a provider to read, a wallet to send).
export function contracts(d: Deployed, runner: ContractRunner) {
  const at = (addr: string, name: string, file = name) => new Contract(addr, artifact(name, file).abi, runner);
  return {
    announcer: at(d.announcer, 'ERC5564Announcer'), registry: at(d.registry, 'ERC6538Registry'), validator: at(d.validator, 'ERC1400TokensValidator'),
    bond: at(d.bond, 'DfabiBond'), rd: at(d.rd, 'RupiahDigital'), factory: at(d.dvpFactory, 'DvPFactory'), instruments: at(d.instrumentRegistry, 'InstrumentRegistry'),
  };
}

export const chainNow = async (p: Provider) => BigInt((await p.getBlock('latest'))!.timestamp);

// The custodian signs the calldata of the exact call `msgSender` will make, minus the certificate argument.
export async function cert(
  p: Provider, d: Deployed, key: string, fn: string, msgSender: string, args: readonly unknown[],
  o: { expiry?: bigint; key?: string; nonce?: bigint } = {},
): Promise<string> {
  const { bond, validator } = contracts(d, p);
  const placeholder = bond.interface.encodeFunctionData(fn, [...args, new Uint8Array(CERTIFICATE_LENGTH)]);
  return signCertificate(o.key ?? key, {
    domainSeparator: await bond.generateDomainSeparator(),
    msgSender,
    token: d.bond,
    payload: payloadWithoutCertificate(placeholder),
    expiry: o.expiry ?? (await chainNow(p)) + 600n,
    nonce: o.nonce ?? (await validator.usedCertificateNonce(d.bond, msgSender)),
  });
}

export type LoggedAnnouncement = Announcement & { txHash: string; blockNumber: number; caller: string };

// Announcements from `fromBlock` (to `toBlock`, default latest), optionally of one token (the announcing contract), read in LOG_RANGE chunks.
export async function announcements(p: Provider, d: Deployed, fromBlock: number, token: string | null = null, toBlock?: number): Promise<LoggedAnnouncement[]> {
  const announcer = contracts(d, p).announcer;
  const filter = announcer.filters.Announcement(null, null, token);
  const end = toBlock ?? (await p.getBlockNumber());
  const out: LoggedAnnouncement[] = [];
  for (let from = fromBlock; from <= end; from += LOG_RANGE) {
    for (const l of (await announcer.queryFilter(filter, from, Math.min(from + LOG_RANGE - 1, end))) as any[]) {
      out.push({
        schemeId: l.args.schemeId, stealthAddress: l.args.stealthAddress, ephemeralPubKey: l.args.ephemeralPubKey, metadata: l.args.metadata,
        txHash: l.transactionHash, blockNumber: l.blockNumber, caller: l.args.caller,
      });
    }
  }
  return out;
}

// A payment to `meta` with its memo, signed by `senderKey`.
export function pay(chainId: bigint, meta: string, senderKey: string, token: string, amount: bigint, partition?: string) {
  const ephemeralKey = hexlify(randomBytes(32));
  const s = deriveStealth(meta, ephemeralKey);
  const ctx: MemoContext = { chainId, token, stealthAddress: s.stealthAddress, amount, ephemeralPubKey: s.ephemeralPubKey, partition };
  return { s, ctx, ephemeralKey, memo: buildMemo({ senderKey, ephemeralKey, receiverMetaAddress: meta, ctx }) };
}

// What a receiver (or BI, holding the receiver's view key) reads from an announcement: token, amount, partition and the authenticated sender.
export function read(chainId: bigint, ann: Announcement, viewKey: string, kind: 'rd' | 'bond') {
  const m: any = kind === 'rd' ? parseTokenMetadata(ann.metadata) : parseBondMetadata(ann.metadata);
  const ctx: MemoContext = { chainId, token: m.token, stealthAddress: ann.stealthAddress, amount: m.amount, ephemeralPubKey: ann.ephemeralPubKey, partition: m.partition };
  return { token: m.token as string, amount: m.amount as bigint, partition: m.partition as string | undefined, memo: m.memo as string, ctx, sender: openMemo(m.memo, viewKey, ctx)?.sender ?? null };
}

// BI's view: every announcement resolved to a bank, with amount and authenticated sender.
export function biRows(chainId: bigint, anns: Announcement[], holders: ViewKeyHolder[], kind: 'rd' | 'bond') {
  return scanAll(anns, holders).map((r) => {
    const p = read(chainId, r.announcement, holders.find((h) => h.id === r.bank)!.viewKey, kind);
    return { bank: r.bank, amount: p.amount, sender: p.sender, tx: (r.announcement as Partial<LoggedAnnouncement>).txHash ?? '-' };
  });
}
