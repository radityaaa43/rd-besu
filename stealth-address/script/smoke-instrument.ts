// One-off instrument data smoke check on a live Besu network. Not part of CI.
// Deploys the InstrumentRegistry, an RD token and a DfabiBond, registers both instruments from the sample records,
// sets the ERC-1400 document, then reads everything back and recomputes the hashes from the JSON.
// Needs the ERC1820 registry (node script/deploy-erc1820.ts) for the bond.
// Usage: forge build && set -a && . ./.env.smoke && set +a && node script/smoke-instrument.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, encodeBytes32String, toUtf8Bytes, keccak256 } from 'ethers';
import { canonicalJson, recordHash, registrationArgs, validateRecord } from '../ts/instrument.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
// The deployer plays registry owner, registrar, RD issuer and bond controller; production would split them.
const me = new Wallet(DEPLOYER_KEY, provider);
const TRANCHE_A = encodeBytes32String('TRANCHE-A');

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('FAILED: ' + msg);
}
const artifact = (name: string) => JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
async function deploy(name: string, ...args: unknown[]): Promise<Contract> {
  const { abi, bytecode } = artifact(name);
  const c = await new ContractFactory(abi, bytecode.object, me).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}
const tx = async (label: string, p: Promise<any>) => {
  const r = await (await p).wait();
  console.log(label.padEnd(34), r.hash);
  return r;
};
const sample = (f: string) => JSON.parse(readFileSync(`docs/samples/${f}`, 'utf8'));

const net = await provider.getNetwork();
console.log('chainId', net.chainId.toString());
check((await provider.getCode('0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24')) !== '0x', 'ERC1820 registry is deployed');

const registry = await deploy('InstrumentRegistry');
const announcer = await deploy('ERC5564Announcer');
const validator = await deploy('ERC1400TokensValidator');
const rd = await deploy('RupiahDigital', me.address, await announcer.getAddress());
const bond = await deploy('DfabiBond', 'DFABI Series 1', 'DFB1', [me.address], [TRANCHE_A], await announcer.getAddress());
const [registryAddr, rdAddr, bondAddr] = [await registry.getAddress(), await rd.getAddress(), await bond.getAddress()];
console.log('registry', registryAddr, '| rd', rdAddr, '| bond', bondAddr);
await tx('setRegistrar(deployer)', registry.setRegistrar(me.address, true));

// The records are the sample files with this run's token addresses. They are validated, then registered.
const rdRecord = sample('rd.sample.json');
rdRecord.extensions.cash.token = rdAddr;
const bondRecord = sample('dfabi-bdt-v1.2.sample.json');
bondRecord.bdt.dlt_platform_information_smart_contract = bondAddr;
for (const r of [rdRecord, bondRecord]) check(validateRecord(r).valid, `${r.kind} record is valid: ${validateRecord(r).errors.join('; ')}`);

const uri = (r: any) => `https://example.invalid/instruments/${r.kind}-${r.kind === 'RD' ? rdAddr : bondAddr}.json`;
for (const [token, record] of [[rdAddr, rdRecord], [bondAddr, bondRecord]] as const) {
  const a = registrationArgs(record);
  await tx(`register ${record.kind}`, registry.register(token, a.kind, a.profileVersion, a.primaryId, a.dataHash, uri(record)));
}

// ERC-1400 standard slot for the DFABI document.
const docHash = recordHash(bondRecord);
await tx('setDocument ICMA-BDT-v1.2', bond.setDocument(encodeBytes32String('ICMA-BDT-v1.2'), uri(bondRecord), docHash));

// Read everything back and recompute each hash from the JSON the way a reader would (canonical JSON, keccak256).
for (const [token, record] of [[rdAddr, rdRecord], [bondAddr, bondRecord]] as const) {
  const stored = await registry.getInstrument(token);
  check(stored.token === token && stored.version === 1n, `${record.kind}: token and version 1`);
  check(stored.kind === encodeBytes32String(record.kind), `${record.kind}: kind`);
  check(stored.profileVersion === '1', `${record.kind}: profile version`);
  check(stored.primaryId === (record.kind === 'RD' ? 'IDR' : 'IDDFA0000013'), `${record.kind}: primary id`);
  check(stored.dataUri === uri(record), `${record.kind}: uri`);
  check(stored.registrant === me.address, `${record.kind}: registrant`);
  check(stored.dataHash === keccak256(toUtf8Bytes(canonicalJson(JSON.parse(JSON.stringify(record))))), `${record.kind}: stored hash equals keccak256(canonical JSON)`);
  check(stored.dataHash === recordHash(record), `${record.kind}: stored hash equals recordHash`);
  check((await registry.versionCount(token)) === 1n, `${record.kind}: one version`);
}
const [docUri, docHashBack] = await bond.getDocument(encodeBytes32String('ICMA-BDT-v1.2'));
check(docUri === uri(bondRecord) && docHashBack === docHash, 'ERC-1400 getDocument returns the same uri and hash');

// A correction is a new version; version 1 stays readable and unchanged.
const corrected = JSON.parse(JSON.stringify(bondRecord));
corrected.bdt.amounts_tranche_amount = '400000000000';
const c = registrationArgs(corrected);
await tx('registerVersion DFABI (correction)', registry.registerVersion(bondAddr, c.kind, c.profileVersion, c.primaryId, c.dataHash, uri(corrected)));
check((await registry.versionCount(bondAddr)) === 2n, 'two versions');
check((await registry.getInstrument(bondAddr)).dataHash === recordHash(corrected), 'latest is the correction');
check((await registry.getInstrumentVersion(bondAddr, 1n)).dataHash === recordHash(bondRecord), 'version 1 is unchanged');
check(recordHash(corrected) !== recordHash(bondRecord), 'the correction has a different hash');

// A second registration for the same token, and a call from a non-registrar, are refused.
const stranger = Wallet.createRandom().connect(provider);
const a = registrationArgs(rdRecord);
let refused = 0;
for (const call of [() => registry.register.staticCall(rdAddr, a.kind, a.profileVersion, a.primaryId, a.dataHash, 'x'), () => (registry.connect(stranger) as Contract).register.staticCall(stranger.address, a.kind, a.profileVersion, a.primaryId, a.dataHash, 'x')]) {
  try { await call(); } catch { refused++; }
}
check(refused === 2, 'a duplicate token and a non-registrar are both refused');

console.log('OK: registry deployed; RD and DFABI registered from validated sample records; hashes recomputed from the JSON match; setDocument matches; version 2 appended, version 1 unchanged');
process.exit(0);
