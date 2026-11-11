// Operator tool (run on the operator host, key file in /dev/shm, then shred): mint the long-lived READ-ONLY token of the S11 compare job.
//   node --experimental-transform-types signer/src/mintCompareToken.ts <private.pem path> <out file> [days (default 30)]
// Writes the token to <out file> (mode 0600). Prints only `wrote <out> exp=<UTC> permissions=<list>`; never the token, never key material.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mintScopedToken } from './rpcToken.ts';

const PERMISSIONS = ['eth:call', 'eth:blockNumber', 'eth:chainId']; // Besu method-level JWT permissions: no eth:*, no net, no web3
const [pem, out, daysArg = '30'] = process.argv.slice(2);
const days = Number(daysArg);
if (!pem || !out || !Number.isInteger(days) || days < 1) { process.stderr.write('usage: mintCompareToken.ts <private.pem path> <out file> [days >= 1 (default 30)]\n'); process.exit(2); }
try {
  const now = Math.floor(Date.now() / 1000);
  const token = mintScopedToken(readFileSync(pem, 'utf8'), PERMISSIONS, days * 86400, () => now);
  writeFileSync(out, token + '\n', { mode: 0o600 });
  chmodSync(out, 0o600); // writeFileSync's mode only applies to a new file
  process.stdout.write(`wrote ${out} exp=${new Date((now + days * 86400) * 1000).toISOString().slice(0, 19)}Z permissions=${PERMISSIONS.join(',')}\n`);
} catch (e) {
  process.stderr.write(`mintCompareToken: ${e instanceof Error && e.message.startsWith('rpc token:') ? e.message : 'cannot read the key file or write the token file'}\n`);
  process.exit(1);
}
