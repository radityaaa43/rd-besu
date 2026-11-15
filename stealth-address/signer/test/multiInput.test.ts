// Multi-input RD (user 2026-11-15 "ya lanjutkan sesuai rekomendasi analyst"; live: bank B held 2,012,022 RD in 68 addresses, the largest 999,999, so a
// 1,000,000 bid failed with 422). The RD a party pays may come from several of its own stealth addresses when no single one covers the amount:
// the largest first, as few as possible, the last one paying only the remainder. A DvP RD leg is k transfers into the escrow (settle counts the
// escrow's balance; cancel refunds all of it to the buyer), the buyer address is the largest input. A plain rd-transfer is k sendStealth payments,
// each to a fresh address of the receiver. The bond stays one holding (cancel refunds the bond only when it is fully funded).
import { Interface } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scan } from '../../ts/stealth.ts';
import { B, FakeChain, RD, decodeRaw, fund, start } from './fixtures.ts';

const ESCROW = '0x00000000000000000000000000000000000000e5';
const TRADE = '0x' + '0a'.repeat(32);
const rdAbi = new Interface([
  'function transfer(address to, uint256 amount)',
  'function sendStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)',
]);

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
const run = async (chain: FakeChain) => { const s = await start(chain); stop = s.stop; return s; };
const sent = (chain: FakeChain) => chain.sent.map((raw) => { const tx = decodeRaw(raw); return { from: tx.from, call: rdAbi.parseTransaction({ data: tx.data })! }; });

// 400k, 500k, 300k: no single one covers 1,000,000; the total does.
const fragmented = (chain: FakeChain) => [fund(chain, 'rd', 400_000n, 1), fund(chain, 'rd', 500_000n, 2), fund(chain, 'rd', 300_000n, 3)];

describe('DvP RD leg from several own addresses', () => {
  it('/dvp/bid answers with the largest holding as the buyer when only the total covers the price', async () => {
    const chain = new FakeChain();
    const [, big] = fragmented(chain);
    const { call } = await run(chain);
    const r = await call('POST', '/dvp/bid', { tradeId: TRADE, price: '1000000', sellerMeta: B.metaAddress });
    expect(r.status).toBe(200);
    expect(r.json.buyer).toBe(big);
    expect(chain.sent).toEqual([]);
  });

  it('dvp-leg rd sends 500k + 400k + 100k into the escrow, the source first, and reports every tx', async () => {
    const chain = new FakeChain();
    const [a, big, c] = fragmented(chain);
    const { call } = await run(chain);
    const r = await call('POST', '/intent', { kind: 'dvp-leg', leg: 'rd', from: 'A', amount: '1000000', escrow: ESCROW, source: big });
    expect(r.status).toBe(200);
    const txs = sent(chain);
    expect(txs.map((t) => [t.from, t.call.name, (t.call.args[0] as string).toLowerCase(), t.call.args[1]])).toEqual([
      [big, 'transfer', ESCROW, 500_000n], [a, 'transfer', ESCROW, 400_000n], [c, 'transfer', ESCROW, 100_000n],
    ]);
    expect(r.json.from).toBe(big);
    expect(r.json.txHashes).toHaveLength(3);
    expect(r.json.txHash).toBe(r.json.txHashes[2]);
  });

  it('the daily outflow counts the k inputs once: 500k + 400k + 100k = 1,000,000', async () => {
    const chain = new FakeChain();
    const [, big] = fragmented(chain);
    const { call } = await run(chain);
    await call('POST', '/intent', { kind: 'dvp-leg', leg: 'rd', from: 'A', amount: '1000000', escrow: ESCROW, source: big });
    // what the chain logs for those txs: one RD Transfer per input, from the input to the escrow
    sent(chain).forEach((t, i) => chain.xfers.push({ token: RD, from: t.from!, to: ESCROW, value: t.call.args[1] as bigint, blockNumber: 10 + i }));
    chain.head = 12;
    expect((await call('GET', '/outflow?since=0')).json).toMatchObject({ RD: '1000000', DFABI: '0' });
  });

  it('one holding that covers keeps the single-transfer path (one tx, txHashes of one)', async () => {
    const chain = new FakeChain();
    fragmented(chain);
    const one = fund(chain, 'rd', 1_000_000n, 4);
    const { call } = await run(chain);
    const r = await call('POST', '/intent', { kind: 'dvp-leg', leg: 'rd', from: 'A', amount: '1000000', escrow: ESCROW, source: one });
    expect(r.status).toBe(200);
    expect(sent(chain).map((t) => [t.from, t.call.args[1]])).toEqual([[one, 1_000_000n]]);
    expect(r.json.txHashes).toEqual([r.json.txHash]);
  });

  it('the total short of the amount -> 422 insufficient_holdings, nothing sent', async () => {
    const chain = new FakeChain();
    fragmented(chain);
    const { call } = await run(chain);
    expect((await call('POST', '/dvp/bid', { tradeId: TRADE, price: '1200001', sellerMeta: B.metaAddress })).json.error).toBe('insufficient_holdings');
    expect((await call('POST', '/intent', { kind: 'dvp-leg', leg: 'rd', from: 'A', amount: '1200001', escrow: ESCROW })).json.error).toBe('insufficient_holdings');
    expect(chain.sent).toEqual([]);
  });
});

describe('rd-transfer from several own addresses', () => {
  it('pays 60 + 40 as two payments, each to a fresh address of the receiver that the receiver finds', async () => {
    const chain = new FakeChain();
    const a = fund(chain, 'rd', 60n, 1), b = fund(chain, 'rd', 60n, 2);
    const { call } = await run(chain);
    const r = await call('POST', '/intent', { kind: 'rd-transfer', from: 'A', to: { metaAddress: B.metaAddress }, amount: '100' });
    expect(r.status).toBe(200);
    const txs = sent(chain);
    expect(txs.map((t) => [t.from, t.call.name, t.call.args[1]])).toEqual([[a, 'sendStealth', 60n], [b, 'sendStealth', 40n]]);
    const receivers = txs.map((t) => t.call.args[0] as string);
    expect(new Set(receivers).size).toBe(2);
    for (const t of txs) {
      const ann = { schemeId: 1n, stealthAddress: t.call.args[0], ephemeralPubKey: t.call.args[2], metadata: t.call.args[3] };
      expect(scan([ann], B.viewKey, B.spendKey)).toHaveLength(1);
    }
    expect(r.json.txHashes).toHaveLength(2);
  });
});

describe('the bond stays one holding', () => {
  it('bond-transfer and /dvp/offer split over two holdings -> 422, nothing sent', async () => {
    const chain = new FakeChain();
    fund(chain, 'bond', 1n, 1); fund(chain, 'bond', 1n, 2);
    const { call } = await run(chain);
    expect((await call('POST', '/intent', { kind: 'bond-transfer', from: 'A', to: { metaAddress: B.metaAddress }, amount: '2' })).json.error).toBe('insufficient_holdings');
    expect((await call('POST', '/dvp/offer', { tradeId: TRADE, amount: '2', buyerMeta: B.metaAddress })).json.error).toBe('insufficient_holdings');
    expect(chain.sent).toEqual([]);
  });
});
