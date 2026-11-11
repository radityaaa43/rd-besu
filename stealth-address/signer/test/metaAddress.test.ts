// GET /meta-address (S9 D2): public data only, derived inside the signer from the loaded keys. RED first.
import { Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A, FakeChain, start } from './fixtures.ts';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });

describe('GET /meta-address (role bank)', () => {
  it('returns the party, the meta-address derived from spend+view keys and the identity ACCOUNT address (the ERC-6538 registry key)', async () => {
    const s = await start(new FakeChain()); stop = s.stop;
    const r = await s.call('GET', '/meta-address');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ party: 'A', metaAddress: A.metaAddress, identityAddress: new Wallet(A.identityKey).address });
  });

  it('never carries key material and logs no key', async () => {
    const s = await start(new FakeChain()); stop = s.stop;
    const r = await s.call('GET', '/meta-address');
    for (const k of [A.spendKey, A.viewKey, A.identityKey]) {
      expect(r.text.toLowerCase()).not.toContain(k.slice(2).toLowerCase());
      expect(s.rec.logs.join('\n').toLowerCase()).not.toContain(k.slice(2).toLowerCase());
    }
  });

  it('only GET: POST -> 404 not_found', async () => {
    const s = await start(new FakeChain()); stop = s.stop;
    const r = await s.call('POST', '/meta-address', {});
    expect([r.status, r.json.error]).toEqual([404, 'not_found']);
  });
});

describe('GET /meta-address (role custodian)', () => {
  it('403 role_forbidden: the custodian holds no spend/view key', async () => {
    const s = await start(new FakeChain(), { cfg: { role: 'custodian' }, keys: { certKey: '0x' + '55'.repeat(32) } }); stop = s.stop;
    const r = await s.call('GET', '/meta-address');
    expect([r.status, r.json.error]).toEqual([403, 'role_forbidden']);
  });
});
