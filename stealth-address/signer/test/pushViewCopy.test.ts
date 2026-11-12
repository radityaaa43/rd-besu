// S11 rework: the view-key push Job entrypoint (src/pushViewCopy.ts). Everything is injected (files, the own-signer GET, the mTLS fetch): no network, no real key.
// stdout is exactly `PUSH <slot> <http status>`; exit 0 only on 200; no key in any output. RED first: the module does not exist yet.
import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { MtlsOptions } from '../src/mtls.ts';
import { run, slotOf, type PushIO } from '../src/pushViewCopy.ts';
import { A, B } from './fixtures.ts';

const idA = new Wallet(A.identityKey).address;
const FILES: Record<string, string> = {
  '/keys/viewKey': A.viewKey + '\n',
  '/tls/client.key': 'FAKE-CLIENT-KEY-PEM', '/tls/client.crt': 'FAKE-CLIENT-CERT-PEM', '/tls/ca.crt': 'FAKE-CA-PEM',
  // the Job never mounts these; if the code asked for them the read would show it
  '/keys/spendKey': A.spendKey, '/keys/identityKey': A.identityKey,
};
const ENV = { PARTY: 'A', DOOR_URL: 'https://st-gw-1.example:8550', TLS_DIR: '/tls', VIEWKEY_FILE: '/keys/viewKey' };
const SECRETS = [A.viewKey, A.spendKey, A.identityKey, B.viewKey, 'FAKE-CLIENT-KEY-PEM'];

type Put = { url: string; method?: string; headers?: HeadersInit; body?: string };
function rig(o: { putStatus?: number; signer?: () => Response; putThrows?: boolean; files?: Record<string, string> } = {}) {
  const r = { out: [] as string[], err: [] as string[], reads: [] as string[], gets: [] as string[], mtls: [] as MtlsOptions[], puts: [] as Put[] };
  const files = o.files ?? FILES;
  const io: PushIO = {
    read: (p) => { r.reads.push(p); if (!(p in files)) throw new Error(`ENOENT ${p} ${A.viewKey}`); return files[p]; },
    get: (async (url: string) => {
      r.gets.push(String(url));
      return o.signer ? o.signer() : new Response(JSON.stringify({ party: 'A', metaAddress: A.metaAddress, identityAddress: idA }), { status: 200 });
    }) as unknown as typeof fetch,
    mtlsFetch: (opts) => {
      r.mtls.push(opts);
      return (async (url: string, init: RequestInit = {}) => {
        r.puts.push({ url: String(url), method: init.method, headers: init.headers, body: init.body as string });
        if (o.putThrows) throw new Error(`TLS failure while sending ${A.viewKey}`); // a cause that holds the key: it must not be echoed
        return new Response(`{"echo":"${A.viewKey}"}`, { status: o.putStatus ?? 200 }); // an answer body: it must not be printed
      }) as unknown as typeof fetch;
    },
    out: (l) => r.out.push(l),
    err: (l) => r.err.push(l),
  };
  return { r, io };
}
const everything = (r: ReturnType<typeof rig>['r']) => (r.out.join('\n') + '\n' + r.err.join('\n')).toLowerCase();
const noKey = (r: ReturnType<typeof rig>['r']) => { for (const k of SECRETS) expect(everything(r)).not.toContain(k.replace(/^0x/, '').toLowerCase()); expect(everything(r)).not.toMatch(/[0-9a-f]{64}/); };

describe('slotOf', () => {
  it('derives the slot from the signer PARTY', () => {
    expect([slotOf('A'), slotOf('B'), slotOf('C')]).toEqual(['bank-a', 'bank-b', 'bank-c']);
    for (const p of ['', 'BI', 'D', 'a', 'bank-a', 'AB']) expect(() => slotOf(p)).toThrow();
  });
});

describe('pushViewCopy run', () => {
  it('pushes the own view key + the signer\'s public meta-address and identity over mTLS with SNI viewcopy-1; prints PUSH bank-a 200; exit 0', async () => {
    const { r, io } = rig();
    const code = await run(['bank-a'], ENV, io);
    expect([code, r.out, r.err]).toEqual([0, ['PUSH bank-a 200'], []]);
    expect(r.gets).toEqual(['http://stealth-signer:8080/meta-address']);
    expect(r.mtls).toEqual([{ key: 'FAKE-CLIENT-KEY-PEM', cert: 'FAKE-CLIENT-CERT-PEM', ca: 'FAKE-CA-PEM', servername: 'viewcopy-1' }]);
    expect(r.puts).toHaveLength(1);
    expect([r.puts[0].url, r.puts[0].method]).toEqual(['https://st-gw-1.example:8550/viewcopy/bank-a', 'PUT']);
    expect(JSON.parse(r.puts[0].body!)).toEqual({ viewKey: A.viewKey, metaAddress: A.metaAddress, identityAddress: idA });
    noKey(r);
  });

  it('reads only the viewKey file of the key mount (never spendKey or identityKey), plus the three mTLS files', async () => {
    const { r, io } = rig();
    await run(['bank-a'], ENV, io);
    expect(r.reads.sort()).toEqual(['/keys/viewKey', '/tls/ca.crt', '/tls/client.crt', '/tls/client.key']);
  });

  it('defaults: own signer http://stealth-signer:8080, key /keys/viewKey, TLS /tls, SNI viewcopy-1; a trailing slash on the door is dropped', async () => {
    const { r, io } = rig();
    expect(await run(['bank-a'], { PARTY: 'A', DOOR_URL: 'https://door:8550/' }, io)).toBe(0);
    expect(r.puts[0].url).toBe('https://door:8550/viewcopy/bank-a');
    expect(r.mtls[0].servername).toBe('viewcopy-1');
  });

  it('any status other than 200 is printed as is and the exit code is 1', async () => {
    for (const status of [201, 403, 404, 422, 502]) {
      const { r, io } = rig({ putStatus: status });
      expect([await run(['bank-a'], ENV, io), r.out]).toEqual([1, [`PUSH bank-a ${status}`]]);
      noKey(r); // the answer body (which here echoes a key) is never printed
    }
  });

  it('--as-slot sends the same body to ANOTHER slot and prints that slot: the negative proof', async () => {
    const { r, io } = rig({ putStatus: 403 });
    const code = await run(['bank-a', '--as-slot', 'bank-b'], ENV, io);
    expect([code, r.out]).toEqual([1, ['PUSH bank-b 403']]);
    expect(r.puts[0].url).toBe('https://st-gw-1.example:8550/viewcopy/bank-b');
    expect(JSON.parse(r.puts[0].body!)).toEqual({ viewKey: A.viewKey, metaAddress: A.metaAddress, identityAddress: idA });
    noKey(r);
  });

  it('--as-slot cannot smuggle a path: refused before any network call', async () => {
    for (const slot of ['../intent', 'bank-b/x', 'Bank-B', '', 'bank b', 'bank-b?x=1']) {
      const { r, io } = rig();
      expect([slot, await run(['bank-a', '--as-slot', slot], ENV, io)]).toEqual([slot, 1]);
      expect([r.gets, r.puts, r.out]).toEqual([[], [], []]);
    }
  });

  it('refuses an id that is not derived from PARTY: nothing read, nothing sent, nothing printed on stdout', async () => {
    for (const [id, party] of [['bank-b', 'A'], ['bank-c', 'A'], ['bi', 'A'], ['A', 'A'], ['bank-a', 'B'], ['bank-a', 'D'], ['bank-a', ''], ['BANK-A', 'A']] as const) {
      const { r, io } = rig();
      expect([id, party, await run([id], { ...ENV, PARTY: party }, io)]).toEqual([id, party, 1]);
      expect([r.reads, r.gets, r.mtls, r.puts, r.out]).toEqual([[], [], [], [], []]);
      expect(r.err).toHaveLength(1);
    }
    const { r, io } = rig();
    expect(await run(['bank-a'], { ...ENV, PARTY: undefined }, io)).toBe(1);
    expect([r.reads, r.puts]).toEqual([[], []]);
  });

  it('usage errors exit 2 and send nothing', async () => {
    for (const argv of [[], ['bank-a', 'x'], ['bank-a', '--as-slot'], ['bank-a', '--as-slot', 'bank-b', 'x'], ['bank-a', '--other', 'bank-b']]) {
      const { r, io } = rig();
      expect([argv, await run(argv, ENV, io)]).toEqual([argv, 2]);
      expect([r.reads, r.gets, r.puts, r.out]).toEqual([[], [], [], []]);
    }
  });

  it('a missing DOOR_URL, an unreadable file or an unusable own-signer answer: exit 1, no PUT, a fixed error line, no key', async () => {
    const cases: Array<ReturnType<typeof rig> & { env: Record<string, string | undefined> }> = [
      { ...rig(), env: { ...ENV, DOOR_URL: undefined } },
      { ...rig({ files: {} }), env: ENV },
      { ...rig({ signer: () => new Response('boom', { status: 500 }) }), env: ENV },
      { ...rig({ signer: () => new Response(JSON.stringify({ party: 'A' }), { status: 200 }) }), env: ENV },
      { ...rig({ signer: () => new Response('not json', { status: 200 }) }), env: ENV },
    ];
    for (const c of cases) {
      expect(await run(['bank-a'], c.env, c.io)).toBe(1);
      expect([c.r.puts, c.r.out]).toEqual([[], []]);
      expect(c.r.err).toHaveLength(1);
      expect(c.r.err[0]).toMatch(/^push failed: /);
      noKey(c.r);
    }
  });

  it('a transport failure prints no cause (it could hold a key) and exits 1', async () => {
    const { r, io } = rig({ putThrows: true });
    expect([await run(['bank-a'], ENV, io), r.out]).toEqual([1, []]);
    expect(r.err).toEqual(['push failed: request or file error']);
    noKey(r);
  });

  it('stdout is only ever PUSH lines: across every scenario no other text on stdout', async () => {
    for (const o of [{}, { putStatus: 403 }, { putStatus: 502 }]) {
      const { r, io } = rig(o);
      await run(['bank-a'], ENV, io);
      for (const l of r.out) expect(l).toMatch(/^PUSH bank-[a-c] [0-9]{3}$/);
    }
  });
});
