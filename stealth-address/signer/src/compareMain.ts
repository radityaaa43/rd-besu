// S11 compare job entrypoint (same image as the signer, other command). Not unit-tested (needs a real RPC node and the view-copy files); the logic is in compare.ts.
//   node --experimental-transform-types signer/src/compareMain.ts once
// Env: RPC_URL, CHAIN_ID, REGISTRY (public ERC-6538 registry address), VIEWCOPIES_DIR (files <id>.viewKey, <id>.metaAddress and the PUBLIC <id>.identityAddress),
// RPC_TOKEN_FILE (optional: file holding the static bearer token, a read-only JWT minted by mintCompareToken.ts; sent on every request).
// Prints one line per party (bi, bank-a, bank-b, bank-c) and a summary line to stdout, never a key. Exit 0 only when all four are OK.
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { createProvider } from './chainPort.ts';
import { compareViewKeys, exitCode, formatRow, guardProvider, summaryLine } from './compare.ts';
import { loadViewCopiesWithIdentity } from './keys.ts';
import { SCHEME_ID } from '../../ts/stealth.ts';

const env = (n: string) => process.env[n] ?? (() => { throw new Error(`missing env ${n}`); })();
const log = (line: string) => process.stdout.write(line + '\n');
if (process.argv[2] !== 'once') { process.stderr.write('usage: compareMain.ts once\n'); process.exit(2); }

// ABI inline; signature: src/ERC6538Registry.sol:22 (public mapping getter).
const registryAbi = new Interface(['function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)']);
const tokenFile = process.env.RPC_TOKEN_FILE;
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
// the guard allows eth_call, eth_blockNumber and eth_chainId only (the token's Besu permissions are the first layer, this is the second)
const provider = guardProvider(createProvider(env('RPC_URL'), BigInt(env('CHAIN_ID')), token ? () => token : undefined));
const registry = env('REGISTRY');
const read = async (identity: string) => {
  const out = await provider.call({ to: registry, data: registryAbi.encodeFunctionData('stealthMetaAddressOf', [identity, SCHEME_ID]) });
  return registryAbi.decodeFunctionResult('stealthMetaAddressOf', out)[0] as string;
};

let rows;
try {
  rows = await compareViewKeys({ registry: read, banks: loadViewCopiesWithIdentity(env('VIEWCOPIES_DIR')) });
} catch (e) { // an unreadable copy file (message names the file, never a value)
  log(`compare: FAIL ${e instanceof Error ? e.message : 'cannot load the view copies'}`);
  process.exit(1);
}
rows.forEach((r) => log(formatRow(r)));
log(summaryLine(rows));
process.exit(exitCode(rows));
