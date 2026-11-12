// Option C keygen Job (same image as the signer, other command): the key is made IN this pod and written into a PRE-CREATED, EMPTY Secret of the party's own namespace through the kube API
// (node:https, the dedicated ServiceAccount; its Role is get/update/patch on that one Secret). Only PUBLIC values are printed.
//   node --experimental-transform-types signer/src/keygen.ts stealth-cert-key certKey            -> `KEYGEN certKey address=0x..`
//   node --experimental-transform-types signer/src/keygen.ts stealth-bi-keys spendKey viewKey    -> `KEYGEN bi metaAddress=0x..`
// Exactly these two sets exist. issuerKey is never generated here (it is the on-chain issuer key, moved by S12). An existing target key means NO write (a lost key is a new identity, never silent).
// stdout: the one line above. stderr: fixed strings only (never a response body, a key or a cause). Exit 0 ok, 1 refused/failed, 2 usage.
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { metaAddressOf } from '../../ts/stealth.ts';
import { SA_DIR } from './viewcopyStore.ts';

export type KubeReply = { status: number; body: string };
export type KubeRequest = { method: 'GET' | 'PATCH'; path: string; body?: string; contentType?: string };
export type KeygenIO = {
  read: (path: string) => string;
  kube: (r: KubeRequest) => Promise<KubeReply>;
  randomKey: () => string; // 0x + 64 hex secp256k1 private key
  out: (line: string) => void;
  err: (line: string) => void;
};

class KeygenError extends Error {} // the only error text that may reach stderr: fixed strings of this file

const SETS: Record<string, string[]> = { 'stealth-cert-key': ['certKey'], 'stealth-bi-keys': ['spendKey', 'viewKey'] };
const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');

export async function run(argv: string[], _env: Record<string, string | undefined>, io: KeygenIO, dir = SA_DIR): Promise<number> {
  const [secret, ...kinds] = argv;
  const want = secret === undefined ? undefined : Object.hasOwn(SETS, secret) ? SETS[secret] : undefined;
  if (!want || kinds.length !== want.length || want.some((k, i) => kinds[i] !== k)) { io.err('usage: keygen.ts stealth-cert-key certKey | stealth-bi-keys spendKey viewKey'); return 2; }
  try {
    let ns: string;
    try { ns = io.read(`${dir}/namespace`).trim(); } catch { throw new KeygenError('service account namespace unreadable'); }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns)) throw new KeygenError('namespace is not valid');
    const path = `/api/v1/namespaces/${ns}/secrets/${secret}`;
    const cur = await io.kube({ method: 'GET', path });
    if (cur.status !== 200) throw new KeygenError(`kube API answered ${cur.status} reading the Secret (it must exist, empty, and be readable by this service account)`);
    let rv: string; let present: string[];
    try { const j = JSON.parse(cur.body); rv = String(j.metadata.resourceVersion); present = Object.keys(j.data ?? {}); } catch { throw new KeygenError('unexpected answer reading the Secret'); }
    if (present.some((k) => want.includes(k))) throw new KeygenError('Secret already holds a target key (not empty): refusing to overwrite a key');
    const keys = want.map(() => io.randomKey());
    if (new Set(keys).size !== keys.length) throw new KeygenError('random source repeated itself');
    const data = Object.fromEntries(want.map((k, i) => [k, b64(keys[i])]));
    // resourceVersion makes a concurrent change a 409, never an overwrite
    const res = await io.kube({ method: 'PATCH', path, contentType: 'application/merge-patch+json', body: JSON.stringify({ metadata: { resourceVersion: rv }, data }) });
    if (res.status < 200 || res.status >= 300) throw new KeygenError(`kube API answered ${res.status} writing the Secret: nothing stored`);
    io.out(secret === 'stealth-cert-key' ? `KEYGEN certKey address=${new Wallet(keys[0]).address}` : `KEYGEN bi metaAddress=${metaAddressOf(keys[0], keys[1])}`);
    return 0;
  } catch (e) {
    io.err(e instanceof KeygenError ? e.message : 'keygen failed');
    return 1;
  }
}

// Real kube transport: token, CA and namespace from the projected ServiceAccount files; the response is returned to run() only (never printed).
export function realKube(env: Record<string, string | undefined>, read: (p: string) => string = (p) => readFileSync(p, 'utf8'), request: typeof httpsRequest = httpsRequest, dir = SA_DIR) {
  return (r: KubeRequest): Promise<KubeReply> => new Promise((resolve, reject) => {
    let token: string, ca: string;
    try { token = read(`${dir}/token`).trim(); ca = read(`${dir}/ca.crt`); } catch { reject(new KeygenError('service account files unreadable')); return; }
    const host = env.KUBERNETES_SERVICE_HOST;
    if (!host) { reject(new KeygenError('kube API address missing')); return; }
    const headers: Record<string, string | number> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (r.body !== undefined) { headers['content-type'] = r.contentType ?? 'application/json'; headers['content-length'] = Buffer.byteLength(r.body); }
    const req = request({ host, port: Number(env.KUBERNETES_SERVICE_PORT ?? 443), method: r.method, path: r.path, ca, servername: 'kubernetes.default.svc', headers }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => reject(new KeygenError('kube API unreachable')));
    req.end(r.body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io: KeygenIO = {
    read: (p) => readFileSync(p, 'utf8'), kube: realKube(process.env), randomKey: () => Wallet.createRandom().privateKey,
    out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(`keygen: ${l}\n`),
  };
  process.exitCode = await run(process.argv.slice(2), process.env, io);
}
