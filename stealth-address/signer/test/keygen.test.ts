import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { metaAddressOf } from '../../ts/stealth.ts';
import { run, type KeygenIO, type KubeReply } from '../src/keygen.ts';

// The Option-C keygen Job: the key is made IN the pod, written into a PRE-CREATED Secret through the kube API, and only PUBLIC values are printed.
type Call = { method: string; path: string; body?: string; contentType?: string };
function harness(secret: { data?: Record<string, string>; resourceVersion?: string } | 'missing' | 'forbidden' = {}) {
  const calls: Call[] = []; const out: string[] = []; const err: string[] = []; let n = 0;
  const io: KeygenIO = {
    read: (p) => { if (p.endsWith('/namespace')) return 'rd-stealth-bi\n'; throw new Error(`unexpected read ${p}`); },
    kube: async (r): Promise<KubeReply> => {
      calls.push(r);
      if (secret === 'missing') return { status: 404, body: '{"message":"secrets not found"}' };
      if (secret === 'forbidden') return { status: 403, body: '{"message":"secret value would be here"}' };
      if (r.method === 'GET') return { status: 200, body: JSON.stringify({ metadata: { resourceVersion: secret.resourceVersion ?? '42' }, data: secret.data }) };
      return { status: 200, body: '{}' };
    },
    randomKey: () => `0x${(++n).toString(16).padStart(64, '1')}`,
    out: (l) => out.push(l), err: (l) => err.push(l),
  };
  return { io, calls, out, err };
}
const patched = (calls: Call[]) => JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!);
const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

describe('keygen (Option C)', () => {
  it('certKey: patches ONLY certKey into stealth-cert-key and prints only the derived address', async () => {
    const h = harness();
    expect(await run(['stealth-cert-key', 'certKey'], {}, h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/namespaces/rd-stealth-bi/secrets/stealth-cert-key', 'PATCH /api/v1/namespaces/rd-stealth-bi/secrets/stealth-cert-key']);
    const p = patched(h.calls);
    expect(Object.keys(p.data)).toEqual(['certKey']);
    const key = decode(p.data.certKey);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.out).toEqual([`KEYGEN certKey address=${new Wallet(key).address}`]);
    expect(h.calls.find((c) => c.method === 'PATCH')!.contentType).toBe('application/merge-patch+json');
    expect(p.metadata.resourceVersion).toBe('42'); // optimistic concurrency: a concurrent change is a 409, never an overwrite
    expect(h.out.join() + h.err.join()).not.toContain(key.slice(2));
  });
  it('spendKey+viewKey: patches both into stealth-bi-keys (never issuerKey) and prints only the public meta-address', async () => {
    const h = harness({ data: { issuerKey: 'AAAA' } }); // the copied issuerKey is already there and is left alone
    expect(await run(['stealth-bi-keys', 'spendKey', 'viewKey'], {}, h.io)).toBe(0);
    const p = patched(h.calls);
    expect(Object.keys(p.data).sort()).toEqual(['spendKey', 'viewKey']);
    const [s, v] = [decode(p.data.spendKey), decode(p.data.viewKey)];
    expect(s).not.toBe(v);
    expect(h.out).toEqual([`KEYGEN bi metaAddress=${metaAddressOf(s, v)}`]);
    expect(h.out.join() + h.err.join()).not.toContain(s.slice(2));
    expect(h.out.join() + h.err.join()).not.toContain(v.slice(2));
  });
  it('refuses to overwrite: an existing target key means NO patch and a fixed message', async () => {
    for (const [secret, kinds, data] of [['stealth-cert-key', ['certKey'], { certKey: 'x' }], ['stealth-bi-keys', ['spendKey', 'viewKey'], { viewKey: 'x' }]] as const) {
      const h = harness({ data });
      expect(await run([secret, ...kinds], {}, h.io)).toBe(1);
      expect(h.calls.map((c) => c.method)).toEqual(['GET']);
      expect(h.err.join()).toMatch(/not empty|already/);
    }
  });
  it('allows only the two fixed secret/kind sets: anything else exits 2 before any kube call', async () => {
    for (const argv of [[], ['stealth-cert-key'], ['stealth-cert-key', 'issuerKey'], ['stealth-bi-keys', 'issuerKey'], ['stealth-bi-keys', 'spendKey'], ['stealth-bi-keys', 'spendKey', 'viewKey', 'issuerKey'],
      ['stealth-keys', 'spendKey', 'viewKey'], ['stealth-cert-key', 'deployerKey'], ['stealth-cert-key', 'certKey', 'certKey'], ['../x', 'certKey']]) {
      const h = harness();
      expect(await run(argv, {}, h.io), JSON.stringify(argv)).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });
  it('API errors: fixed status-only message, the response body (a Secret or an error text) is never echoed', async () => {
    for (const [mode, code] of [['missing', 404], ['forbidden', 403]] as const) {
      const h = harness(mode);
      expect(await run(['stealth-cert-key', 'certKey'], {}, h.io)).toBe(1);
      expect(h.err.join()).toContain(String(code));
      expect(h.err.join() + h.out.join()).not.toMatch(/secret value|not found"/);
    }
  });
  it('a failed PATCH prints nothing public either (no address of a key that was not stored)', async () => {
    const h = harness();
    const io = { ...h.io, kube: async (r: Call): Promise<KubeReply> => (r.method === 'PATCH' ? { status: 409, body: '{}' } : { status: 200, body: JSON.stringify({ metadata: { resourceVersion: '1' } }) }) };
    expect(await run(['stealth-cert-key', 'certKey'], {}, io)).toBe(1);
    expect(h.out).toEqual([]);
  });
});
