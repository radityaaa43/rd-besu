// S11 rework: BI's own kube API client for the Secret stealth-bi-viewcopies (node:https only, no client library). The transport is injected: no network here.
// RED first: src/viewcopyStore.ts does not exist yet.
import { EventEmitter } from 'node:events';
import type { RequestOptions, request as httpsRequest } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SA_DIR, SECRET_NAME, ViewCopyStoreError, createViewCopyStore } from '../src/viewcopyStore.ts';
import type { ViewCopyFiles } from '../src/types.ts';
import { A, B } from './fixtures.ts';

const TOKEN = 'tok-' + 'f3'.repeat(20);
const CA = '-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----\n';
const FILES: Record<string, string> = { '/sa/token': TOKEN + '\n', '/sa/ca.crt': CA, '/sa/namespace': 'rd-stealth-bi\n' };
const ENV = { KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '6443' };
const files: ViewCopyFiles = { viewKey: A.viewKey, metaAddress: A.metaAddress, identityAddress: '0x' + 'ab'.repeat(20) };

type Seen = { options: RequestOptions; body: string };
// A stand-in for node:https request(): records the options and the body, answers with `status`, or fails the socket.
function fakeRequest(status: number | 'socket-error', seen: Seen[]) {
  return ((options: RequestOptions, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: (b: string) => void };
    req.end = (body: string) => {
      seen.push({ options, body });
      if (status === 'socket-error') req.emit('error', new Error(`ECONNREFUSED while sending ${body}`)); // a cause that holds the key: it must not be echoed
      else cb({ statusCode: status, resume() { /* the answer (the whole Secret) is dropped unread */ } });
    };
    return req;
  }) as unknown as typeof httpsRequest;
}
const read = (reads: string[] = []) => (p: string) => { reads.push(p); if (!(p in FILES)) throw new Error('ENOENT ' + p); return FILES[p]; };
const store = (status: number | 'socket-error', seen: Seen[], reads: string[] = []) => createViewCopyStore({ dir: '/sa', env: ENV, read: read(reads), request: fakeRequest(status, seen) });

afterEach(() => vi.restoreAllMocks());

describe('createViewCopyStore().put', () => {
  it('sends exactly one PATCH of the three keys to the one Secret, merge-patch, token and CA from the projected files', async () => {
    const seen: Seen[] = [], reads: string[] = [];
    await store(200, seen, reads).put('bank-a', files);
    expect(seen).toHaveLength(1);
    const { options, body } = seen[0];
    expect([options.host, options.port, options.method]).toEqual(['10.0.0.1', 6443, 'PATCH']);
    expect(options.path).toBe(`/api/v1/namespaces/rd-stealth-bi/secrets/${SECRET_NAME}`);
    expect(SECRET_NAME).toBe('stealth-bi-viewcopies');
    expect(options.ca).toBe(CA);
    expect(options.servername).toBe('kubernetes.default.svc');
    expect(options.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/merge-patch+json' });
    expect((options.headers as Record<string, unknown>)['content-length']).toBe(Buffer.byteLength(body));
    const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');
    expect(JSON.parse(body)).toEqual({ data: { 'bank-a.viewKey': b64(files.viewKey), 'bank-a.metaAddress': b64(files.metaAddress), 'bank-a.identityAddress': b64(files.identityAddress) } });
    expect(Object.keys(JSON.parse(body))).toEqual(['data']); // nothing but data: no metadata, no other key of the Secret
    expect(reads.sort()).toEqual(['/sa/ca.crt', '/sa/namespace', '/sa/token']);
  });

  it('the default directory is the projected ServiceAccount; the port defaults to 443', async () => {
    expect(SA_DIR).toBe('/var/run/secrets/kubernetes.io/serviceaccount');
    const seen: Seen[] = [], reads: string[] = [];
    const rd = (p: string) => { reads.push(p); return p.endsWith('namespace') ? 'rd-stealth-bi' : 'x'; };
    await createViewCopyStore({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, read: rd, request: fakeRequest(200, seen) }).put('bank-b', files);
    expect(reads.sort()).toEqual([`${SA_DIR}/ca.crt`, `${SA_DIR}/namespace`, `${SA_DIR}/token`]);
    expect(seen[0].options.port).toBe(443);
    expect(JSON.parse(seen[0].body).data).toHaveProperty(['bank-b.viewKey']);
  });

  it('reads the token again on every call (it rotates)', async () => {
    const seen: Seen[] = [];
    let n = 0;
    const s = createViewCopyStore({ dir: '/sa', env: ENV, read: (p) => (p.endsWith('token') ? `t${++n}` : read()(p)), request: fakeRequest(200, seen) });
    await s.put('bank-a', files); await s.put('bank-a', files);
    expect(seen.map((x) => (x.options.headers as Record<string, string>).authorization)).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('2xx resolves; 404, 401/403 and 5xx are typed errors carrying the HTTP status only', async () => {
    await expect(store(200, []).put('bank-a', files)).resolves.toBeUndefined();
    await expect(store(201, []).put('bank-a', files)).resolves.toBeUndefined();
    const kind = async (status: number) => {
      try { await store(status, []).put('bank-a', files); } catch (e) { return e instanceof ViewCopyStoreError ? [e.kind, e.status] : ['other', null]; }
      return ['none', null];
    };
    expect(await kind(404)).toEqual(['not_found', 404]);
    expect(await kind(403)).toEqual(['forbidden', 403]);
    expect(await kind(401)).toEqual(['forbidden', 401]);
    expect(await kind(500)).toEqual(['unavailable', 500]);
    expect(await kind(503)).toEqual(['unavailable', 503]);
    expect(await kind(409)).toEqual(['unexpected', 409]);
  });

  it('a socket error is a typed unavailable error that does not echo the cause', async () => {
    const e: any = await store('socket-error', []).put('bank-a', files).catch((x) => x);
    expect(e).toBeInstanceOf(ViewCopyStoreError);
    expect([e.kind, e.status]).toEqual(['unavailable', null]);
    expect(e.message).not.toContain(A.viewKey.slice(2));
  });

  it('no key, token or CA in any error text; nothing logged to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const texts: string[] = [];
    for (const status of [404, 403, 500, 409, 'socket-error' as const]) {
      const e: any = await store(status, []).put('bank-a', files).catch((x) => x);
      texts.push(String(e.message));
    }
    const all = texts.join('\n').toLowerCase();
    for (const secret of [A.viewKey, A.metaAddress, B.viewKey, TOKEN, 'TESTCA']) expect(all).not.toContain(secret.replace(/^0x/, '').toLowerCase());
    expect(all).not.toMatch(/[0-9a-f]{64}/);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('an id that is not a plain slot name is refused before any file read or request', async () => {
    const seen: Seen[] = [], reads: string[] = [];
    for (const id of ['', '../x', 'Bank-A', 'bank a', 'bank-a.viewKey', 'bank/a', '-a'])
      await expect(store(200, seen, reads).put(id, files)).rejects.toBeInstanceOf(ViewCopyStoreError);
    expect(seen).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('unreadable ServiceAccount files, no kube API address or a bad namespace: typed error, no request', async () => {
    const seen: Seen[] = [];
    const none = createViewCopyStore({ dir: '/sa', env: ENV, read: () => { throw new Error('ENOENT'); }, request: fakeRequest(200, seen) });
    await expect(none.put('bank-a', files)).rejects.toBeInstanceOf(ViewCopyStoreError);
    const noHost = createViewCopyStore({ dir: '/sa', env: {}, read: read(), request: fakeRequest(200, seen) });
    await expect(noHost.put('bank-a', files)).rejects.toBeInstanceOf(ViewCopyStoreError);
    const badNs = createViewCopyStore({ dir: '/sa', env: ENV, read: (p) => (p.endsWith('namespace') ? '../kube-system' : 'x'), request: fakeRequest(200, seen) });
    await expect(badNs.put('bank-a', files)).rejects.toBeInstanceOf(ViewCopyStoreError);
    expect(seen).toEqual([]);
  });
});
