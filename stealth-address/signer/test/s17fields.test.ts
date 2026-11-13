// S17 follow-ups asked by the keyless Lensa adapter (2026-11-13): additive fields only, no shape change, plus the escrow refund route (SPEC GATE).
import { Interface, Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANCHE_A } from '../../ts/chain.ts';
import { A, BOND, FakeChain, RD, decodeRaw, fund, start } from './fixtures.ts';

const FACTORY = '0x00000000000000000000000000000000000000f1', ANNOUNCER = '0x00000000000000000000000000000000000000a1';
const ESCROW = '0x00000000000000000000000000000000000000e5';
let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
const run = async (chain: FakeChain, opts: Parameters<typeof start>[1] = {}) => { const s = await start(chain, opts); stop = s.stop; return s; };

describe('additive fields', () => {
  it('/history rows carry partition (TRANCHE_A for DFABI, null for RD)', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 5n, 1);
    fund(chain, 'bond', 2n, 2);
    const { call } = await run(chain);
    const h = (await call('GET', '/history')).json.history;
    expect(h.map((r: any) => [r.token, r.partition])).toEqual([[RD, null], [BOND, TRANCHE_A]]);
  });
  it('/ledger rows carry blockNumber of the announcing tx', async () => {
    const chain = new FakeChain();
    fund(chain, 'bond', 3n, 42);
    const keys = { issuerKey: '0x' + '99'.repeat(32), spendKey: '0x' + '31'.repeat(32), viewKey: '0x' + '32'.repeat(32), viewCopies: [{ id: 'bank-a', viewKey: A.viewKey, metaAddress: A.metaAddress }] };
    const { call } = await run(chain, { cfg: { role: 'bi', party: 'BI' }, keys: keys as any });
    const rows = (await call('GET', '/ledger?kind=bond')).json.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bank: 'bank-a', amount: '3', blockNumber: 42 });
  });
  it('/meta-address carries the public contract addresses the signer is configured with', async () => {
    const { call } = await run(new FakeChain(), { cfg: { dvpFactory: FACTORY, announcer: ANNOUNCER } });
    const j = (await call('GET', '/meta-address')).json;
    expect(j.contracts).toEqual({ rd: RD, bond: BOND, announcer: ANNOUNCER, dvpFactory: FACTORY });
    expect(j.metaAddress).toBe(A.metaAddress);
  });
});

describe('POST /dvp/cancel (refund of an expired, unsettled escrow)', () => {
  it('sends escrow.cancel() from a throwaway key: RD back to the buyer, bond back to the seller with the stored refund cert', async () => {
    const chain = new FakeChain();
    const { call } = await run(chain);
    const r = await call('POST', '/dvp/cancel', { escrow: ESCROW });
    expect(r.status).toBe(200);
    const tx = decodeRaw(chain.sent[0]!);
    expect(tx.to?.toLowerCase()).toBe(ESCROW);
    expect(tx.data).toBe(new Interface(['function cancel()']).encodeFunctionData('cancel'));
    expect(tx.from).not.toBe(new Wallet(A.identityKey).address);
    expect(r.json).toMatchObject({ escrow: ESCROW, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  });
  it('not an address -> 422 bad_request', async () => {
    const { call } = await run(new FakeChain());
    expect((await call('POST', '/dvp/cancel', { escrow: 'x' })).json.error).toBe('bad_request');
  });
});

