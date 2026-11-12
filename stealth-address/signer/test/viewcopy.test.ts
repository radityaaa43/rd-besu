// S11 rework: `PUT /viewcopy/:id` on the BI signer. A bank pushes ITS OWN view-key copy (OPA at the gateway already limited the caller to its own slot); the signer
// validates it (shape, the view key belongs to the meta-address, the ERC-6538 registry holds the same viewing key), writes it through the injected store FIRST and only
// then updates its in-memory copies. RED first: the route does not exist yet. No key may appear in any response, log line or thrown text.
import { Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metaAddressOf } from '../../ts/stealth.ts';
import type { BiKeys, ViewCopyFiles, ViewCopyStore } from '../src/types.ts';
import { A, B, FakeChain, fund, start } from './fixtures.ts';

const BI_SPEND = '0x' + '31'.repeat(32), BI_VIEW = '0x' + '32'.repeat(32), ISSUER = '0x' + '99'.repeat(32);
const biCfg = { role: 'bi' as const, party: 'BI' };
const idA = new Wallet(A.identityKey).address;
const idB = new Wallet(B.spendKey).address; // any distinct account address works as B's registry key
const bodyA: ViewCopyFiles = { viewKey: A.viewKey, metaAddress: A.metaAddress, identityAddress: idA };
const bodyB: ViewCopyFiles = { viewKey: B.viewKey, metaAddress: B.metaAddress, identityAddress: idB };

class FakeStore implements ViewCopyStore {
  puts: Array<{ id: string; files: ViewCopyFiles }> = [];
  fail = false;
  async put(id: string, files: ViewCopyFiles) {
    if (this.fail) throw new Error(`patch failed for ${files.viewKey}`); // a cause that holds the key: it must never be echoed
    this.puts.push({ id, files });
  }
}

// fresh BI key set per test: the signer replaces viewCopies on its keys object
const freshKeys = (): BiKeys => ({ issuerKey: ISSUER, spendKey: BI_SPEND, viewKey: BI_VIEW, viewCopies: [] });

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });

async function startBi(opts: { store?: FakeStore | null; chain?: FakeChain } = {}) {
  const chain = opts.chain ?? new FakeChain();
  chain.registry.set(idA.toLowerCase(), A.metaAddress);
  chain.registry.set(idB.toLowerCase(), B.metaAddress);
  const store = opts.store === null ? undefined : (opts.store ?? new FakeStore());
  const s = await start(chain, { cfg: biCfg, keys: freshKeys(), store }); stop = s.stop;
  return { ...s, chain, store };
}

const SECRETS = [A.viewKey, A.spendKey, A.identityKey, B.viewKey, B.spendKey, BI_SPEND, BI_VIEW, ISSUER];
const noKeyAnywhere = (s: { rec: { logs: string[]; bodies: string[] } }) => {
  const all = (s.rec.logs.join('\n') + s.rec.bodies.join('\n')).toLowerCase();
  for (const k of SECRETS) expect(all).not.toContain(k.slice(2).toLowerCase());
};

describe('PUT /viewcopy/:id, role bi, the accepted push', () => {
  it('stores a valid copy: 200 {id, status: stored}, the store gets exactly the 3 files, GET /ledger then includes the bank', async () => {
    const chain = new FakeChain(); fund(chain, 'rd', 500n, 5);
    const s = await startBi({ chain });
    expect((await s.call('GET', '/ledger?kind=rd')).json.rows).toEqual([]);
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json]).toEqual([200, { id: 'bank-a', status: 'stored' }]);
    expect(s.store!.puts).toEqual([{ id: 'bank-a', files: { viewKey: A.viewKey, metaAddress: A.metaAddress, identityAddress: idA } }]);
    const l = await s.call('GET', '/ledger?kind=rd');
    expect(l.json.rows.map((x: any) => [x.bank, x.amount])).toEqual([['bank-a', '500']]);
    noKeyAnywhere(s);
  });

  it('the same body again: 200 unchanged and NO second store write', async () => {
    const s = await startBi();
    await s.call('PUT', '/viewcopy/bank-a', bodyA);
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json]).toEqual([200, { id: 'bank-a', status: 'unchanged' }]);
    expect(s.store!.puts).toHaveLength(1);
  });

  it('a different copy for the same slot replaces it: stored again, one entry per id', async () => {
    const chain = new FakeChain(); fund(chain, 'rd', 500n, 5);
    const s = await startBi({ chain });
    await s.call('PUT', '/viewcopy/bank-a', bodyA);
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyB); // B's keys are registered under idB, valid on their own
    expect([r.status, r.json.status]).toEqual([200, 'stored']);
    expect(s.store!.puts.map((p) => p.files.viewKey)).toEqual([A.viewKey, B.viewKey]);
    expect((await s.call('GET', '/ledger?kind=rd')).json.rows).toEqual([]); // A's payment is no longer resolved: the slot now holds B's view key
  });

  it('each of bank-a, bank-b, bank-c is a valid slot', async () => {
    const s = await startBi();
    for (const id of ['bank-a', 'bank-b', 'bank-c']) expect((await s.call('PUT', `/viewcopy/${id}`, bodyA)).status).toBe(200);
    expect(s.store!.puts.map((p) => p.id)).toEqual(['bank-a', 'bank-b', 'bank-c']);
  });
});

describe('PUT /viewcopy/:id, who and where', () => {
  it('id bi or an unknown id: 404, nothing stored', async () => {
    const s = await startBi();
    for (const id of ['bi', 'bank-d', 'BANK-A', 'bank-a/', 'bank-a%2F', '', 'A', 'bank-a/x'])
      expect([id, (await s.call('PUT', `/viewcopy/${id}`, bodyA)).status]).toEqual([id, 404]);
    expect((await s.call('PUT', '/viewcopy', bodyA)).status).toBe(404);
    expect(s.store!.puts).toEqual([]);
  });

  it('other methods on a slot are not routes: 404', async () => {
    const s = await startBi();
    for (const m of ['GET', 'POST', 'DELETE', 'PATCH']) expect([m, (await s.call(m, '/viewcopy/bank-a', m === 'GET' ? undefined : bodyA)).status]).toEqual([m, 404]);
    expect(s.store!.puts).toEqual([]);
  });

  it('role bank: 403 role_forbidden, nothing stored', async () => {
    const store = new FakeStore();
    const s = await start(new FakeChain(), { store }); stop = s.stop; // CONFIG = role bank, party A
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json.error]).toEqual([403, 'role_forbidden']);
    expect((await s.call('PUT', '/viewcopy/bi', bodyA)).status).toBe(403);
    expect(store.puts).toEqual([]);
    noKeyAnywhere(s);
  });

  it('role custodian: 403 role_forbidden, nothing stored', async () => {
    const store = new FakeStore();
    const s = await start(new FakeChain(), { cfg: { role: 'custodian' }, keys: { certKey: '0x' + '55'.repeat(32) }, store }); stop = s.stop;
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json.error]).toEqual([403, 'role_forbidden']);
    expect(store.puts).toEqual([]);
  });
});

describe('PUT /viewcopy/:id, the body', () => {
  it('not JSON, or JSON that is not an object: 400', async () => {
    const s = await startBi();
    for (const b of ['not json', '[1,2]', 'null', '"x"', '']) expect([b, (await s.call('PUT', '/viewcopy/bank-a', b)).status]).toEqual([b, 400]);
    expect(s.store!.puts).toEqual([]);
  });

  it('more than 4096 bytes: 413', async () => {
    const s = await startBi();
    const r = await s.call('PUT', '/viewcopy/bank-a', JSON.stringify({ ...bodyA, pad: 'x'.repeat(4200) }));
    expect(r.status).toBe(413);
    expect(s.store!.puts).toEqual([]);
  });

  it('a missing, extra or odd-shaped field: 422 bad_body, nothing stored, the value never echoed', async () => {
    const s = await startBi();
    const { viewKey: _v, ...noView } = bodyA;
    const bad: unknown[] = [
      {}, noView, { ...bodyA, extra: 'x' }, { ...bodyA, viewKey: 5 }, { ...bodyA, viewKey: A.viewKey.slice(2) }, { ...bodyA, viewKey: A.viewKey.slice(0, -2) },
      { ...bodyA, viewKey: '0x' + 'zz'.repeat(32) }, { ...bodyA, metaAddress: 'st:eth:' + A.metaAddress }, { ...bodyA, metaAddress: A.metaAddress.slice(0, -2) },
      { ...bodyA, metaAddress: null }, { ...bodyA, identityAddress: '0x1234' }, { ...bodyA, identityAddress: idA.slice(2) }, { ...bodyA, identityAddress: ['x'] },
    ];
    for (const b of bad) {
      const r = await s.call('PUT', '/viewcopy/bank-a', b);
      expect([r.status, r.json.error]).toEqual([422, 'bad_body']);
    }
    expect(s.store!.puts).toEqual([]);
    noKeyAnywhere(s);
  });

  it('a view key that does not belong to the meta-address: 422 bad_copy (scanView), nothing stored', async () => {
    const s = await startBi();
    const r = await s.call('PUT', '/viewcopy/bank-a', { ...bodyA, viewKey: B.viewKey });
    expect([r.status, r.json.error]).toEqual([422, 'bad_copy']);
    expect(s.store!.puts).toEqual([]);
    noKeyAnywhere(s);
  });

  it('nothing registered under the identity address: 422 unregistered', async () => {
    const s = await startBi();
    s.chain.registry.delete(idA.toLowerCase());
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json.error]).toEqual([422, 'unregistered']);
    expect(s.store!.puts).toEqual([]);
  });

  it('the registry holds another viewing key: 422 mismatch', async () => {
    const s = await startBi();
    s.chain.registry.set(idA.toLowerCase(), metaAddressOf(A.spendKey, B.viewKey)); // right spend key, wrong viewing key
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json.error]).toEqual([422, 'mismatch']);
    s.chain.registry.set(idA.toLowerCase(), '0x1234'); // not a 66-byte meta-address
    expect((await s.call('PUT', '/viewcopy/bank-a', bodyA)).json.error).toBe('mismatch');
    expect(s.store!.puts).toEqual([]);
  });

  it('the registry read fails: 502 and nothing stored, no cause echoed', async () => {
    const s = await startBi();
    s.chain.registryError = true;
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect(r.status).toBe(502);
    expect(s.store!.puts).toEqual([]);
    noKeyAnywhere(s);
  });
});

describe('PUT /viewcopy/:id, the store', () => {
  it('store error: 502 store_error, the in-memory copies are NOT changed, a retry after recovery stores', async () => {
    const chain = new FakeChain(); fund(chain, 'rd', 500n, 5);
    const s = await startBi({ chain });
    s.store!.fail = true;
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json.error]).toEqual([502, 'store_error']);
    expect((await s.call('GET', '/ledger?kind=rd')).json.rows).toEqual([]); // not in memory
    noKeyAnywhere(s);
    s.store!.fail = false;
    const again = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([again.status, again.json.status]).toEqual([200, 'stored']); // not remembered as unchanged
    expect((await s.call('GET', '/ledger?kind=rd')).json.rows.map((x: any) => x.bank)).toEqual(['bank-a']);
    noKeyAnywhere(s);
  });

  it('a failing replacement leaves the earlier copy in place', async () => {
    const chain = new FakeChain(); fund(chain, 'rd', 500n, 5);
    const s = await startBi({ chain });
    await s.call('PUT', '/viewcopy/bank-a', bodyA);
    s.store!.fail = true;
    expect((await s.call('PUT', '/viewcopy/bank-a', bodyB)).status).toBe(502);
    expect((await s.call('GET', '/ledger?kind=rd')).json.rows.map((x: any) => x.bank)).toEqual(['bank-a']);
    noKeyAnywhere(s);
  });

  it('no store configured: 502 store_error', async () => {
    const s = await startBi({ store: null });
    const r = await s.call('PUT', '/viewcopy/bank-a', bodyA);
    expect([r.status, r.json.error]).toEqual([502, 'store_error']);
  });
});

describe('no key in any output', () => {
  it('a hex run of 64+ digits never appears in a PUT /viewcopy response or in a log line', async () => {
    const s = await startBi();
    const texts: string[] = [];
    const put = async (id: string, b: unknown) => { texts.push((await s.call('PUT', `/viewcopy/${id}`, b)).text); };
    await put('bank-a', bodyA); await put('bank-a', bodyA); await put('bank-a', { ...bodyA, viewKey: B.viewKey }); await put('bank-d', bodyA);
    await put('bank-a', 'not json'); await put('bank-a', { ...bodyA, extra: 1 });
    s.store!.fail = true; await put('bank-b', bodyB);
    s.chain.registryError = true; await put('bank-c', bodyA);
    for (const t of [...texts, ...s.rec.logs]) expect(t).not.toMatch(/[0-9a-fA-F]{64}/);
    noKeyAnywhere(s);
  });
});
