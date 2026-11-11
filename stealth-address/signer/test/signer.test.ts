// RED tests for PLAN S8 proofs (1)-(4). They fail until signer/src/server.ts is implemented.
import { Interface } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTokenMetadata } from '../../ts/token.ts';
import { scan } from '../../ts/stealth.ts';
import { A, B, CHAIN_ID, FakeChain, RD, decodeRaw, fund, noise, scanA, start } from './fixtures.ts';

const rdAbi = new Interface(['function sendStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)']);
let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });

const rdIntent = { kind: 'rd-transfer', from: 'A', to: { metaAddress: B.metaAddress }, amount: '100' };

describe('(1) rd-transfer intent -> signed raw tx', () => {
  it('recovered from == the stealth address that holds the funds; receiver can scan the payment', async () => {
    const chain = new FakeChain();
    const held = fund(chain, 'rd', 500n);
    const s = await start(chain); stop = s.stop;
    const r = await s.call('POST', '/intent', rdIntent);
    expect(r.status).toBe(200);
    const tx = decodeRaw(r.json.rawTx);
    expect(tx.from).toBe(held);
    expect(tx.to?.toLowerCase()).toBe(RD.toLowerCase());
    expect(tx.chainId).toBe(CHAIN_ID);
    expect(r.json.txHash).toBe(tx.hash);
    expect(chain.sent).toEqual([r.json.rawTx]); // submitted once, to the own RPC
    const [receiver, amount, eph, tag, memo] = rdAbi.decodeFunctionData('sendStealth', tx.data);
    expect(amount).toBe(100n);
    const ann = { schemeId: 1n, stealthAddress: receiver, ephemeralPubKey: eph, metadata: buildTokenMetadata(tag, RD, 100n, memo) };
    expect(scan([ann], B.viewKey, B.spendKey).map((f) => f.stealthAddress)).toEqual([receiver]);
  });
});

describe('(2) intent for another party is rejected', () => {
  it('from != configured party -> 403 wrong_party, nothing signed, nothing sent', async () => {
    const chain = new FakeChain(); fund(chain, 'rd', 500n);
    const s = await start(chain); stop = s.stop;
    const r = await s.call('POST', '/intent', { ...rdIntent, from: 'B' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('wrong_party');
    expect(chain.sent).toEqual([]);
  });

  it('unknown kind -> 422 unknown_kind; bad amounts -> 422 bad_amount', async () => {
    const chain = new FakeChain(); fund(chain, 'rd', 500n);
    const s = await start(chain); stop = s.stop;
    const k = await s.call('POST', '/intent', { ...rdIntent, kind: 'mint' });
    expect([k.status, k.json.error]).toEqual([422, 'unknown_kind']);
    for (const amount of ['0', '-5', '1.5', 'abc', '', 100]) {
      const r = await s.call('POST', '/intent', { ...rdIntent, amount });
      expect([r.status, r.json.error]).toEqual([422, 'bad_amount']);
    }
    expect(chain.sent).toEqual([]);
  });
});

describe('(3) GET /holdings equals scan()', () => {
  it('lists exactly the stealth addresses scan() finds, in order, with no private key field', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 500n, 1); noise(chain); fund(chain, 'bond', 300n, 4);
    const s = await start(chain); stop = s.stop;
    const r = await s.call('GET', '/holdings');
    expect(r.status).toBe(200);
    const expected = scanA(chain).map((f) => f.stealthAddress);
    expect(expected).toHaveLength(2);
    expect(r.json.holdings.map((h: { stealthAddress: string }) => h.stealthAddress)).toEqual(expected);
    expect(r.json.holdings[0]).toMatchObject({ token: RD, amount: '500' });
    expect(r.text).not.toMatch(/privateKey/i);
  });
});

describe('(4) no key value in any response body or log line', () => {
  it('across intent, holdings, history, and error paths', async () => {
    const chain = new FakeChain(); fund(chain, 'rd', 500n); noise(chain);
    const s = await start(chain); stop = s.stop;
    await s.call('POST', '/intent', rdIntent);
    await s.call('POST', '/intent', { ...rdIntent, from: 'B' });
    await s.call('POST', '/intent', '{not json');
    await s.call('POST', '/intent', { ...rdIntent, amount: 'x' });
    await s.call('GET', '/holdings');
    await s.call('GET', '/history');
    await s.call('GET', '/health');
    const keys = [A.spendKey, A.viewKey, A.identityKey, ...scanA(chain).map((f) => f.privateKey)];
    const haystack = [...s.rec.bodies, ...s.rec.logs].join('\n').toLowerCase();
    expect(s.rec.bodies.length).toBeGreaterThan(5);
    for (const k of keys) {
      expect(haystack).not.toContain(k.toLowerCase());
      expect(haystack).not.toContain(k.slice(2).toLowerCase());
    }
  });
});
