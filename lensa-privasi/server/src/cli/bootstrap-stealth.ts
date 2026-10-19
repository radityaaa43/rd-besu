import { fileURLToPath } from 'node:url';
import { BANKS, type BankId } from '../domain.ts';
import { createStealthAdapter, type StealthState } from '../adapters/stealth.ts';
import { withDeadline } from '../deadline.ts';
import { writeState } from '../state.ts';
import { JsonRpcProvider, TRANCHE_A, Wallet, contracts, deployAll, pay } from '../../../../stealth-address/ts/chain.ts';
import { generateMetaAddress } from '../../../../stealth-address/ts/stealth.ts';

const RD_OPENING = 10n ** 13n;
const DFABI_OPENING = 10n ** 6n;
const TX_MS = 120_000;
const ERC1820 = '0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24';

const sent = (p: Promise<{ wait(): Promise<unknown> }>) => withDeadline(p.then((tx) => tx.wait()), TX_MS, 'Transaksi');

// Deploys a fresh stealth stack on Besu (the deployer plays BI), creates and registers the banks' keys, mints their
// opening balances and writes state/stealth.json.
export async function bootstrap(): Promise<void> {
  if (!process.env.RPC_URL || !process.env.DEPLOYER_KEY) {
    try { process.loadEnvFile(fileURLToPath(new URL('../../../../stealth-address/.env.smoke', import.meta.url))); } catch { /* reported below */ }
  }
  const { RPC_URL, DEPLOYER_KEY } = process.env;
  if (!RPC_URL || !DEPLOYER_KEY) throw new Error('RPC_URL dan DEPLOYER_KEY belum diatur (atau stealth-address/.env.smoke tidak ada)');

  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const deployer = new Wallet(DEPLOYER_KEY, provider);
  const { chainId } = await provider.getNetwork();
  const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
  if ((await provider.getCode(ERC1820)) === '0x') throw new Error('ERC1820 registry belum terpasang (node stealth-address/script/deploy-erc1820.ts)');

  console.log('Deploy kontrak stealth...');
  const deployed = await deployAll(deployer);
  const c = contracts(deployed, deployer);

  const banks = {} as StealthState['banks'];
  for (const b of BANKS) {
    const meta = generateMetaAddress();
    banks[b] = { ...meta, identityKey: Wallet.createRandom().privateKey };
    const id = new Wallet(banks[b].identityKey, provider);
    await sent(contracts(deployed, id).registry.registerKeys(1, meta.metaAddress, { gasPrice }));
  }

  for (const b of BANKS) {
    const rd = pay(chainId, banks[b].metaAddress, DEPLOYER_KEY, deployed.rd, RD_OPENING);
    await sent(c.rd.mintStealth(rd.s.stealthAddress, RD_OPENING, rd.s.ephemeralPubKey, rd.s.viewTag, rd.memo, { gasPrice }));
    const bond = pay(chainId, banks[b].metaAddress, DEPLOYER_KEY, deployed.bond, DFABI_OPENING, TRANCHE_A);
    await sent(c.bond.issueByPartitionStealth(TRANCHE_A, bond.s.stealthAddress, DFABI_OPENING, bond.s.ephemeralPubKey, bond.s.viewTag, bond.memo, { gasPrice }));
  }

  const state: StealthState = { chainId, rpcUrl: RPC_URL, deployerKey: DEPLOYER_KEY, deployed, banks, pool: {} };
  writeState('stealth', state);

  const adapter = createStealthAdapter(state, RPC_URL);
  for (const b of BANKS as BankId[]) {
    console.log(`${b}: RD ${await adapter.balanceOf(b, 'RD')}, DFABI ${await adapter.balanceOf(b, 'DFABI')}`);
  }
  console.log('Tersimpan: state/stealth.json');
}
