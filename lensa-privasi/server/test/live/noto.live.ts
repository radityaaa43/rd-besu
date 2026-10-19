import { beforeAll, describe, expect, it } from 'vitest';
import type { LensView, ModelAdapter, StepEvent } from '../../src/adapter.ts';
import { LOAD_AMOUNT } from '../../src/adapter.ts';
import { BANKS, PRICE_PER_UNIT, type FlowId, type FlowRequest, type PartyId } from '../../src/domain.ts';
import { load } from '../../src/adapters/noto.ts';

// LIVE: needs the Paladin cluster and state/noto.json (npm run bootstrap -- noto).
// Run: flock /tmp/lensa-paladin.lock npm run test:live -- test/live/noto.live.ts
let adapter: ModelAdapter;
beforeAll(async () => {
  const a = await load();
  if (!a) throw new Error('state/noto.json tidak ada: jalankan npm run bootstrap -- noto');
  adapter = a;
});

const PARTIES: PartyId[] = ['BI', 'A', 'B', 'C'];
const req = (flow: FlowId, from: PartyId, to: PartyId, amount: string): FlowRequest => ({ model: 'noto', flow, from, to, amount });

async function runFlow(r: FlowRequest) {
  const events: StepEvent[] = [];
  const result = await adapter.run(r, BigInt(r.amount), (s) => events.push(s));
  const lenses = Object.fromEntries(await Promise.all(PARTIES.map(async (p) => [p, await adapter.lens(r, result, p)]))) as Record<PartyId, LensView>;
  return { result, events, lenses };
}

function expectSteps(events: StepEvent[], result: { steps: StepEvent[] }) {
  expect(events.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  expect(events.map((s) => s.label)).toEqual(adapter.stepLabels);
  expect(result.steps).toEqual(events);
  for (const s of events) expect(s.ms).toBeGreaterThanOrEqual(0);
  expect(events[0].ms).toBe(events[1].ms); // one shared boundary for notary check + submit
  expect(events[2].ms).toBeGreaterThan(0);
}

function expectOnChain(v: LensView, txHash: string) {
  expect(v.onChain[0]).toEqual({ label: 'Tx hash', value: txHash });
  expect(v.onChain.some((o) => o.label === 'Input state' && /^0x[0-9a-f]{64}$/.test(o.value))).toBe(true);
  expect(v.onChain.some((o) => o.label === 'Output state' && /^0x[0-9a-f]{64}$/.test(o.value))).toBe(true);
}

describe('noto adapter (live)', () => {
  it('reports health and all five flows enabled', async () => {
    const h = await adapter.health();
    expect(h.ready, h.detail).toBe(true);
    for (const c of Object.values(adapter.capabilities())) expect(c.enabled).toBe(true);
  });

  it('rd-transfer A -> B: clear / clear / notarised / sealed', async () => {
    const [a0, b0] = [await adapter.balanceOf('A', 'RD'), await adapter.balanceOf('B', 'RD')];
    const { result, events, lenses } = await runFlow(req('rd-transfer', 'A', 'B', '1000'));
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.block).toBeGreaterThan(0);
    expectSteps(events, result);
    expect(await adapter.balanceOf('A', 'RD')).toBe(a0 - 1000n);
    expect(await adapter.balanceOf('B', 'RD')).toBe(b0 + 1000n);
    expect([lenses.A.verdict, lenses.B.verdict, lenses.BI.verdict, lenses.C.verdict]).toEqual(['clear', 'clear', 'notarised', 'sealed']);
    expect([lenses.A.role, lenses.B.role, lenses.BI.role, lenses.C.role]).toEqual(['sender', 'receiver', 'regulator', 'outsider']);
    for (const p of ['A', 'B', 'BI'] as const) expect(lenses[p].amount).toBe('1000');
    expect(lenses.BI.counterparty).toBe('A → B'); // owners decoded from BI's own notary copy of the states
    expect(lenses.A.counterparty).toBe('B');
    expect(lenses.B.counterparty).toBe('A');
    expect(lenses.C.amount).toBeNull();
    expect(lenses.C.counterparty).toBeNull();
    for (const p of PARTIES) expectOnChain(lenses[p], result.txHash);
  });

  it('two concurrent rd-transfers from the same sender both succeed', async () => {
    const [a0, b0] = [await adapter.balanceOf('A', 'RD'), await adapter.balanceOf('B', 'RD')];
    const runs = await Promise.all([runFlow(req('rd-transfer', 'A', 'B', '10')), runFlow(req('rd-transfer', 'A', 'B', '11'))]);
    expect(new Set(runs.map((r) => r.result.txHash)).size).toBe(2);
    expect(await adapter.balanceOf('A', 'RD')).toBe(a0 - 21n);
    expect(await adapter.balanceOf('B', 'RD')).toBe(b0 + 21n);
    expect(runs.map((r) => r.lenses.C.verdict)).toEqual(['sealed', 'sealed']);
  });

  it('an outsider whose node has not indexed the tx throws instead of reporting sealed', async () => {
    const r = req('rd-transfer', 'A', 'B', '1');
    const unknown = { txHash: '0x' + '00'.repeat(32), block: 1, steps: [], context: { txIds: ['00000000-0000-4000-8000-000000000000'] } };
    await expect(adapter.lens(r, unknown, 'C')).rejects.toThrow(/belum mengindeks transaksi/);
  }, 60_000);

  it('dfabi-transfer B -> C: outsider A sealed', async () => {
    const { result, events, lenses } = await runFlow(req('dfabi-transfer', 'B', 'C', '2'));
    expectSteps(events, result);
    expect([lenses.B.verdict, lenses.C.verdict, lenses.BI.verdict, lenses.A.verdict]).toEqual(['clear', 'clear', 'notarised', 'sealed']);
    expect(lenses.BI.counterparty).toBe('B → C');
    expect(lenses.A.amount).toBeNull();
    expect(lenses.C.amount).toBe('2');
  });

  it('rd-issue BI -> A: issuer clear, receiver clear, outsiders sealed', async () => {
    const a0 = await adapter.balanceOf('A', 'RD');
    const { result, events, lenses } = await runFlow(req('rd-issue', 'BI', 'A', '5'));
    expectSteps(events, result);
    expect(await adapter.balanceOf('A', 'RD')).toBe(a0 + 5n);
    expect([lenses.BI.verdict, lenses.A.verdict, lenses.B.verdict, lenses.C.verdict]).toEqual(['clear', 'clear', 'sealed', 'sealed']);
    expect(lenses.BI.role).toBe('issuer');
    expect(lenses.BI.amount).toBe('5');
    expect(lenses.B.amount).toBeNull();
  });

  it('dfabi-issue BI -> A is a custodian transfer of unsold units, stated in the lens method', async () => {
    const a0 = await adapter.balanceOf('A', 'DFABI');
    const { result, events, lenses } = await runFlow(req('dfabi-issue', 'BI', 'A', '3'));
    expectSteps(events, result);
    expect(await adapter.balanceOf('A', 'DFABI')).toBe(a0 + 3n);
    expect([lenses.BI.verdict, lenses.A.verdict, lenses.B.verdict, lenses.C.verdict]).toEqual(['clear', 'clear', 'sealed', 'sealed']);
    expect(lenses.BI.method).toContain('transfer dari kustodian BI (unit belum terjual)');
  });

  it('dvp A sells 1 DFABI unit to B for PRICE_PER_UNIT RD', async () => {
    const [aB0, bB0] = [await adapter.balanceOf('A', 'DFABI'), await adapter.balanceOf('B', 'DFABI')];
    const [aR0, bR0] = [await adapter.balanceOf('A', 'RD'), await adapter.balanceOf('B', 'RD')];
    const { result, events, lenses } = await runFlow(req('dvp', 'A', 'B', '1'));
    expectSteps(events, result);
    expect(await adapter.balanceOf('A', 'DFABI')).toBe(aB0 - 1n);
    expect(await adapter.balanceOf('B', 'DFABI')).toBe(bB0 + 1n);
    expect(await adapter.balanceOf('A', 'RD')).toBe(aR0 + PRICE_PER_UNIT);
    expect(await adapter.balanceOf('B', 'RD')).toBe(bR0 - PRICE_PER_UNIT);
    expect([lenses.A.verdict, lenses.B.verdict, lenses.BI.verdict, lenses.C.verdict]).toEqual(['clear', 'clear', 'notarised', 'sealed']);
    expect(lenses.BI.counterparty).toBe('A → B');
    expect(lenses.A.amount).toBe('1');
    expect(lenses.C.amount).toBeNull();
    expectOnChain(lenses.BI, result.txHash);
  });

  it('load: capacity, prepare and a timed cash transfer B -> C', async () => {
    await adapter.prepareLoad(6);
    const cap = await adapter.loadCapacity();
    expect(cap).toBeGreaterThanOrEqual(3 * 3); // (ceil(6/3)+1) units of LOAD_AMOUNT per bank
    const min = Math.min(...(await Promise.all(BANKS.map((b) => adapter.balanceOf(b, 'RD')))).map((x) => Number(x / LOAD_AMOUNT)));
    expect(cap).toBe(3 * min);
    const b0 = await adapter.balanceOf('B', 'RD');
    const s = await adapter.transferForLoad('B', 'C', LOAD_AMOUNT);
    expect(s.confirmedAt).toBeGreaterThan(s.submittedAt);
    expect(await adapter.balanceOf('B', 'RD')).toBe(b0 - LOAD_AMOUNT);
  });
});
