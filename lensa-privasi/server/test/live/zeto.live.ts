import { describe, expect, it } from 'vitest';
import { load } from '../../src/adapters/zeto.ts';
import { type FlowRequest } from '../../src/domain.ts';
import { LOAD_AMOUNT, type StepEvent } from '../../src/adapter.ts';

// Live against the Paladin cluster. Run under the shared lock, one file at a time:
//   flock /tmp/lensa-paladin.lock npm run test:live -- test/live/zeto.live.ts
describe('zeto live', () => {
  it('rd-transfer A->B: four steps and four lenses', async () => {
    const adapter = await load();
    expect(adapter, 'state/zeto.json missing: run npm run bootstrap -- zeto').not.toBeNull();
    const a = adapter!;
    expect(await a.health()).toMatchObject({ ready: true });

    const req: FlowRequest = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };
    const steps: StepEvent[] = [];
    const result = await a.run(req, 1000n, (s) => steps.push(s));
    expect(steps.map((s) => s.label)).toEqual(a.stepLabels);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(steps[0]!.ms).toBe(steps[1]!.ms); // proof + send share one observable boundary
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const [sender, receiver, bi, outsider] = await Promise.all((['A', 'B', 'BI', 'C'] as const).map((p) => a.lens(req, result, p)));
    expect([sender!.verdict, receiver!.verdict, bi!.verdict, outsider!.verdict]).toEqual(['clear', 'clear', 'reported', 'sealed']);
    expect(sender!.amount).toBe('1000');
    expect(receiver!.amount).toBe('1000');
    expect(bi!.amount).toBe('1000');
    expect(outsider!.amount).toBeNull();
    expect(outsider!.counterparty).toBeNull();
    // read back from BI's ledger, not echoed from the request
    for (const l of [sender!, receiver!, bi!]) expect(l.counterparty).toEqual({ from: 'A', to: 'B' });
    expect(outsider!.onChain.length).toBeGreaterThan(1); // tx hash + commitments are public
  });

  it('transferForLoad confirms after the BI report is accepted', async () => {
    const a = (await load())!;
    await a.prepareLoad(3);
    expect(await a.loadCapacity()).toBeGreaterThanOrEqual(3);
    const s = await a.transferForLoad('A', 'B', LOAD_AMOUNT);
    expect(s.confirmedAt).toBeGreaterThan(s.submittedAt);
  });
});
