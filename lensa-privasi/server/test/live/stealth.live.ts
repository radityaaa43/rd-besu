import { beforeAll, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../../src/adapter.ts';
import { PARTIES, type FlowRequest, type PartyId } from '../../src/domain.ts';
import { load } from '../../src/adapters/stealth.ts';

// Needs a bootstrapped stack: npm run bootstrap -- stealth (Besu at 127.0.0.1:8545). Run: npm run test:live -- test/live/stealth.live.ts
let a: ModelAdapter;
beforeAll(async () => {
  const loaded = await load();
  if (!loaded) throw new Error('state/stealth.json tidak ada: jalankan npm run bootstrap -- stealth');
  a = loaded;
});

const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: bigint): FlowRequest => ({ model: 'stealth', flow, from, to, amount: amount.toString() });
const lenses = async (r: FlowRequest, res: Awaited<ReturnType<ModelAdapter['run']>>) =>
  Object.fromEntries(await Promise.all((['BI', 'A', 'B', 'C'] as PartyId[]).map(async (p) => [p, await a.lens(r, res, p)]))) as Record<PartyId, Awaited<ReturnType<ModelAdapter['lens']>>>;

describe('stealth adapter on Besu', () => {
  it('is healthy and holds the opening balances', async () => {
    expect(await a.health()).toEqual({ ready: true, detail: 'ok' });
    expect(await a.balanceOf('A', 'RD')).toBeGreaterThanOrEqual(10n ** 13n - 1n);
  });

  it('rd-transfer A to B: every lens is read with that party\'s own keys', async () => {
    const r = req('rd-transfer', 'A', 'B', 1000n);
    const steps: number[] = [];
    const res = await a.run(r, 1000n, (s) => steps.push(s.index));
    expect(steps).toEqual([0, 1, 2, 3]);
    expect(res.steps.map((s) => s.label)).toEqual(a.stepLabels);
    const l = await lenses(r, res);
    expect(l.A).toMatchObject({ role: 'sender', verdict: 'clear', amount: '1000', counterparty: 'B' });
    expect(l.B).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '1000', counterparty: 'A', method: 'scan + openMemo' });
    expect(PARTIES[l.B.counterparty as PartyId].name).toBe('Bank Mandala');
    expect(l.BI).toMatchObject({ role: 'regulator', verdict: 'viewkey', amount: '1000', counterparty: 'A', method: 'scanAll + openMemo' });
    expect(l.C).toMatchObject({ role: 'outsider', verdict: 'partial', amount: '1000', counterparty: null, method: 'scanView (0 hasil) + openMemo (null)' });
    expect(l.C.onChain.map((o) => o.label)).toEqual(['Tx hash', 'Alamat sekali pakai', 'Memo terenkripsi', 'Nominal (publik)']);
  });

  it('refuses when no single stealth address covers the amount', async () => {
    await expect(a.run(req('rd-transfer', 'A', 'B', 10n ** 15n), 10n ** 15n, () => {})).rejects.toThrow('Saldo di satu alamat stealth tidak cukup');
  });

  it('rd-issue: BI is the issuer and sees it clearly', async () => {
    const r = req('rd-issue', 'BI', 'C', 500n);
    const l = await lenses(r, await a.run(r, 500n, () => {}));
    expect(l.BI).toMatchObject({ role: 'issuer', verdict: 'clear' });
    expect(l.C).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '500', counterparty: 'BI' });
    expect(l.A).toMatchObject({ verdict: 'partial', counterparty: null });
  });

  it('dfabi-issue then dfabi-transfer with a custodian certificate', async () => {
    await a.run(req('dfabi-issue', 'BI', 'A', 20n), 20n, () => {});
    const r = req('dfabi-transfer', 'A', 'C', 5n);
    const l = await lenses(r, await a.run(r, 5n, () => {}));
    expect(l.C).toMatchObject({ verdict: 'clear', amount: '5', counterparty: 'A' });
    expect(l.BI).toMatchObject({ verdict: 'viewkey', amount: '5', counterparty: 'A' });
    expect(l.B).toMatchObject({ verdict: 'partial', amount: '5', counterparty: null });
  });

  it('dvp: seller delivers DFABI, buyer pays DFABI x price in RD, settled at once', async () => {
    const r = req('dvp', 'A', 'B', 3n);
    const l = await lenses(r, await a.run(r, 3n, () => {}));
    expect(l.B).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '3', counterparty: 'A' });
    expect(l.A).toMatchObject({ role: 'sender', verdict: 'clear', amount: '3' });
    expect(l.BI).toMatchObject({ verdict: 'viewkey', amount: '3' });
    expect(l.C).toMatchObject({ verdict: 'partial', counterparty: null });
  });

  it('transferForLoad: prepareLoad pools stealth addresses, confirmedAt is the receipt time', async () => {
    await a.prepareLoad(3);
    expect(await a.loadCapacity()).toBeGreaterThanOrEqual(6); // 3 pairs x (ceil(3/3)+1)
    const s = await a.transferForLoad('B', 'C', 1000n);
    expect(s.confirmedAt).toBeGreaterThan(s.submittedAt);
  });
});
