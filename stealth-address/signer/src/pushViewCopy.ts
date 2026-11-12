// S11 rework: the view-key push Job (same image as the signer, other command), one bank at a time:
//   node --experimental-transform-types signer/src/pushViewCopy.ts <id> [--as-slot <other id>]
// It reads ITS OWN view key from the projected file (only viewKey is mounted, never the spend or identity key), asks the bank's OWN signer for the public meta-address and
// identity address, and PUTs the three values to BI's stealth gateway over mTLS (SNI viewcopy-1, the signer's client cert) at /viewcopy/<id>.
// stdout is exactly `PUSH <slot> <http status>`; the exit code is 0 only for 200. Nothing else is ever printed: no key, no response body, no cause of an error.
// --as-slot sends the same body to ANOTHER slot: the negative proof (OPA must answer 403 there).
// Env: PARTY (A|B|C, the signer's PARTY), DOOR_URL (https://<BI gateway door>:8550), SIGNER_URL (default http://stealth-signer:8080),
// VIEWKEY_FILE (default /keys/viewKey), TLS_DIR (default /tls: client.key, client.crt, ca.crt), DOOR_SERVERNAME (default viewcopy-1).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createMtlsFetch, type MtlsOptions } from './mtls.ts';

class PushError extends Error {} // the only error text that may reach stderr: fixed strings of this file

// The slot a bank owns, derived from its PARTY: "A" -> "bank-a".
export function slotOf(party: string): string {
  if (!/^[ABC]$/.test(party)) throw new PushError('PARTY must be A, B or C');
  return `bank-${party.toLowerCase()}`;
}

export type PushIO = {
  read: (path: string) => string;
  get: typeof fetch; // plain http to the bank's own signer
  mtlsFetch: (o: MtlsOptions) => typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
};

export async function run(argv: string[], env: Record<string, string | undefined>, io: PushIO): Promise<number> {
  try {
    const [id, ...rest] = argv;
    let asSlot: string | undefined;
    if (rest.length === 2 && rest[0] === '--as-slot') asSlot = rest[1];
    else if (rest.length !== 0) throw new PushError('usage: pushViewCopy.ts <id> [--as-slot <other id>]');
    if (!id) throw new PushError('usage: pushViewCopy.ts <id> [--as-slot <other id>]');
    if (id !== slotOf(env.PARTY ?? '')) throw new PushError('id is not the slot of this party'); // before any file or network access
    const slot = asSlot ?? id;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slot)) throw new PushError('slot is not a valid id');
    const need = (n: string) => env[n] || (() => { throw new PushError(`missing env ${n}`); })();
    const door = need('DOOR_URL').replace(/\/$/, '');
    const tls = env.TLS_DIR ?? '/tls';

    const viewKey = io.read(env.VIEWKEY_FILE ?? '/keys/viewKey').trim();
    const pub = await io.get(`${(env.SIGNER_URL ?? 'http://stealth-signer:8080').replace(/\/$/, '')}/meta-address`);
    if (!pub.ok) throw new PushError('own signer did not answer /meta-address');
    const { metaAddress, identityAddress } = (await pub.json()) as { metaAddress?: unknown; identityAddress?: unknown };
    if (typeof metaAddress !== 'string' || typeof identityAddress !== 'string') throw new PushError('own signer answer has no meta-address');

    const put = io.mtlsFetch({
      key: io.read(`${tls}/client.key`), cert: io.read(`${tls}/client.crt`), ca: io.read(`${tls}/ca.crt`), servername: env.DOOR_SERVERNAME ?? 'viewcopy-1',
    });
    const res = await put(`${door}/viewcopy/${slot}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewKey, metaAddress, identityAddress }),
    });
    io.out(`PUSH ${slot} ${res.status}`);
    return res.status === 200 ? 0 : 1;
  } catch (e) {
    io.err(`push failed: ${e instanceof PushError ? e.message : 'request or file error'}`); // never the cause: it could hold a path or a value
    return e instanceof PushError && e.message.startsWith('usage') ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), process.env, {
    read: (p) => readFileSync(p, 'utf8'),
    get: fetch,
    mtlsFetch: createMtlsFetch,
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
  });
}
