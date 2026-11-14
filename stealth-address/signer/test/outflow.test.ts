// Stealth daily limit (user 2026-11-14 "pastikan semua kebijakan berjalan"): GET /outflow?since=<unix seconds> is what this party sent out since
// then, per token, from the chain: ERC20 Transfer events whose `from` is one of its own stealth addresses, in blocks at or after `since`.
// The gateway's OPA asks it (bank.platform.stealth daily_limit) and Lensa shows it (policy usage). Mints/issues come from the issuer account, not a
// stealth address, so they never count; an escrow refund is not subtracted (Paladin and Fabric-X count on submit too).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOND, FakeChain, RD, fund, start } from './fixtures.ts';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
const run = async (chain: FakeChain, opts: Parameters<typeof start>[1] = {}) => { const s = await start(chain, opts); stop = s.stop; return s; };
const OTHER = '0x' + 'ee'.repeat(20);

describe('GET /outflow', () => {
  it('sums own sends per token at or after `since`; others, earlier blocks and inflows do not count', async () => {
    const chain = new FakeChain();
    const rd = fund(chain, 'rd', 100n, 1);
    const bond = fund(chain, 'bond', 10n, 2);
    chain.times.set(5, 1000n); chain.times.set(6, 2000n); chain.times.set(7, 3000n);
    chain.xfers.push(
      { token: RD, from: rd, to: OTHER, value: 7n, blockNumber: 5 }, // before since
      { token: RD, from: rd, to: OTHER, value: 11n, blockNumber: 6 },
      { token: RD, from: rd, to: OTHER, value: 13n, blockNumber: 7 },
      { token: BOND, from: bond, to: OTHER, value: 2n, blockNumber: 7 },
      { token: RD, from: OTHER, to: rd, value: 1000n, blockNumber: 7 }, // inflow
      { token: RD, from: OTHER, to: OTHER, value: 5000n, blockNumber: 7 }, // somebody else
      { token: RD, from: '0x' + '00'.repeat(20), to: rd, value: 9n, blockNumber: 7 }, // mint to us
    );
    chain.head = 7;
    const { call } = await run(chain);
    const r = await call('GET', '/outflow?since=2000');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ party: 'A', since: 2000, blockNumber: 7, RD: '24', DFABI: '2' });
    expect((await call('GET', '/outflow?since=0')).json).toMatchObject({ RD: '31', DFABI: '2' });
    expect((await call('GET', '/outflow?since=3001')).json).toMatchObject({ RD: '0', DFABI: '0' });
  });

  it('a holding found later counts its earlier sends (addresses are matched at call time)', async () => {
    const chain = new FakeChain();
    const { call } = await run(chain);
    expect((await call('GET', '/outflow?since=0')).json).toMatchObject({ RD: '0', DFABI: '0' });
    const rd = fund(chain, 'rd', 50n, 3);
    chain.xfers.push({ token: RD, from: rd, to: OTHER, value: 4n, blockNumber: 4 });
    expect((await call('GET', '/outflow?since=0')).json).toMatchObject({ RD: '4' });
  });

  it('since must be decimal unix seconds; the custodian has no outflow', async () => {
    const chain = new FakeChain();
    const { call } = await run(chain);
    for (const q of ['', '?since=', '?since=-1', '?since=1.5', '?since=0x10', '?since=1234567890123'])
      expect((await call('GET', '/outflow' + q)).status).toBe(422);
    await stop!(); stop = undefined;
    const c = await run(new FakeChain(), { cfg: { role: 'custodian' }, keys: { certKey: '0x' + '55'.repeat(32) } });
    expect((await c.call('GET', '/outflow?since=0')).status).toBe(403);
  });
});

// Live 2026-11-14: the first /outflow after a start took ~9 s (logs from FROM_BLOCK + the EC scan), past OPA's 1.5 s: a daily-limited request
// right after a roll was denied. main.ts awaits warm() before it listens, so the pod is Ready only with both caches filled.
describe('warm()', () => {
  it('fills the announcement scan and the transfer log cache before any request', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 5n, 1);
    const ann = vi.spyOn(chain, 'announcements');
    const xf = vi.spyOn(chain, 'transfers');
    const { createSigner } = await import('../src/server.ts');
    const { A: keys } = await import('./fixtures.ts');
    const { metaAddress: _m, ...k } = keys;
    const app = createSigner({ party: 'A', role: 'bank', chainId: 1337n, rd: RD, bond: BOND, fromBlock: 0 }, { keys: k, chain, log: () => {} });
    await app.warm();
    expect(ann).toHaveBeenCalled();
    expect(xf).toHaveBeenCalled();
  });
});
