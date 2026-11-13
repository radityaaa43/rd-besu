// Live 2026-11-13: the BI signer was killed (exit 137, liveness timeout) while every /holdings, /history and /ledger call re-ran the EC scan over all
// announcements. The scan is now incremental: announcements are append-only (QBFT final), so each one is scanned once per key set. These tests pin
// that a later call sees new announcements, keeps the earlier ones, and that a changed view-copy set is rescanned.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A, B, FakeChain, fund, start } from './fixtures.ts';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
const run = async (chain: FakeChain, opts: Parameters<typeof start>[1] = {}) => { const s = await start(chain, opts); stop = s.stop; return s; };

describe('incremental scan', () => {
  it('/holdings and /history: a later call adds the new announcements after the earlier ones', async () => {
    const chain = new FakeChain();
    const first = fund(chain, 'rd', 5n, 1);
    const { call } = await run(chain);
    expect((await call('GET', '/holdings')).json.holdings.map((h: any) => h.stealthAddress)).toEqual([first]);
    expect((await call('GET', '/history')).json.history).toHaveLength(1);
    const second = fund(chain, 'bond', 2n, 2);
    expect((await call('GET', '/holdings')).json.holdings.map((h: any) => h.stealthAddress)).toEqual([first, second]);
    expect((await call('GET', '/history')).json.history.map((h: any) => h.stealthAddress)).toEqual([first, second]);
  });
  it('/ledger: new announcements are added; a changed view-copy set (PUT /viewcopy) is rescanned from the start', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 3n, 1);
    const copies = [{ id: 'bank-a', viewKey: A.viewKey, metaAddress: A.metaAddress }];
    const keys = { issuerKey: '0x' + '99'.repeat(32), spendKey: '0x' + '31'.repeat(32), viewKey: '0x' + '32'.repeat(32), viewCopies: copies };
    const { call } = await run(chain, { cfg: { role: 'bi', party: 'BI' }, keys: keys as any });
    expect((await call('GET', '/ledger?kind=rd')).json.rows).toHaveLength(1);
    fund(chain, 'rd', 4n, 2);
    expect((await call('GET', '/ledger?kind=rd')).json.rows.map((r: any) => r.amount)).toEqual(['3', '4']);
    // swap the copy set in place (what a stored PUT /viewcopy does): bank-a's view key is replaced by an unrelated one -> no rows for bank-a
    keys.viewCopies = [{ id: 'bank-b', viewKey: B.viewKey, metaAddress: B.metaAddress }] as any;
    expect((await call('GET', '/ledger?kind=rd')).json.rows).toEqual([]);
  });
});
