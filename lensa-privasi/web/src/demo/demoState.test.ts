import { describe, expect, test } from 'vitest';
import type { FlowId } from '../../../server/src/domain.ts';
import { demoReducer, initialDemo, type DemoState } from './demoState.ts';

const ALL: FlowId[] = ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp'];
const base = (): DemoState => initialDemo('zeto', ALL);
const done = (): DemoState => ({ ...base(), phase: 'done', tab: 'res', steps: [1, 2, 3, 4], result: { txHash: '0x1', block: 1, steps: [], lenses: [] } });

describe('demoReducer', () => {
  test('initial state is rd-transfer from Mandala to Nusantara', () => {
    expect(base()).toMatchObject({ model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', phase: 'idle' });
  });

  test('initial flow falls back to the first enabled flow', () => {
    expect(initialDemo('noto', ['rd-issue', 'dvp']).flow).toBe('rd-issue');
  });

  test('issue flows force from=BI and a bank receiver', () => {
    const s = demoReducer(base(), { type: 'flow', flow: 'rd-issue' });
    expect(s.from).toBe('BI');
    expect(s.to).not.toBe('BI');
    expect(s.to).not.toBe(s.from);
  });

  test('picking a bank flow while from=BI sets from=A', () => {
    const issued = demoReducer(base(), { type: 'flow', flow: 'dfabi-issue' });
    const s = demoReducer(issued, { type: 'flow', flow: 'dvp' });
    expect(s.from).toBe('A');
    expect(s.to).toBe('B');
  });

  test('to never equals from', () => {
    const s = demoReducer(base(), { type: 'from', from: 'B' });
    expect(s.from).toBe('B');
    expect(s.to).toBe('A');
  });

  test('to is never BI', () => {
    const s = demoReducer(base(), { type: 'to', to: 'BI' });
    expect(s.to).toBe('B');
  });

  test('to equal to from is replaced', () => {
    const s = demoReducer(base(), { type: 'to', to: 'A' });
    expect(s.to).toBe('B');
  });

  test('changing model to one where the flow is disabled selects the first enabled flow', () => {
    const s = demoReducer(base(), { type: 'model', model: 'noto', enabled: ['rd-issue', 'dvp'] });
    expect(s).toMatchObject({ model: 'noto', flow: 'rd-issue', from: 'BI' });
  });

  test('changing model keeps the flow when still enabled', () => {
    const s = demoReducer(base(), { type: 'model', model: 'stealth', enabled: ALL });
    expect(s.flow).toBe('rd-transfer');
  });

  test('flow change resets the amount to the asset default', () => {
    expect(demoReducer(base(), { type: 'flow', flow: 'dfabi-transfer' }).amount).toBe('1000');
    expect(demoReducer(base(), { type: 'flow', flow: 'rd-issue' }).amount).toBe('1000000000');
  });

  test.each([
    ['model', { type: 'model', model: 'stealth', enabled: ALL }],
    ['flow', { type: 'flow', flow: 'dvp' }],
    ['from', { type: 'from', from: 'C' }],
    ['to', { type: 'to', to: 'C' }],
    ['amount', { type: 'amount', amount: '5' }],
  ] as const)('a %s change clears the result', (_n, action) => {
    const s = demoReducer(done(), action);
    expect(s).toMatchObject({ phase: 'idle', result: null, error: null, steps: [], tab: 'req' });
  });

  test('selection changes are ignored while a run is in flight', () => {
    const running: DemoState = { ...base(), phase: 'run' };
    expect(demoReducer(running, { type: 'from', from: 'C' })).toBe(running);
  });

  test('run lifecycle: start, step, result', () => {
    let s = demoReducer(base(), { type: 'start' });
    expect(s.phase).toBe('run');
    s = demoReducer(s, { type: 'step', index: 0, ms: 120 });
    s = demoReducer(s, { type: 'step', index: 0, ms: 120 });
    expect(s.steps).toEqual([120]);
    s = demoReducer(s, { type: 'result', result: { txHash: '0xab', block: 9, steps: [{ index: 0, label: 'a', ms: 130 }], lenses: [] } });
    expect(s).toMatchObject({ phase: 'done', tab: 'res', steps: [130] });
  });

  test('error keeps the reason and shows the response tab', () => {
    const s = demoReducer({ ...base(), phase: 'run' }, { type: 'error', reason: 'Saldo Bank Mandala tidak cukup' });
    expect(s).toMatchObject({ phase: 'error', tab: 'res', error: 'Saldo Bank Mandala tidak cukup' });
  });
});
