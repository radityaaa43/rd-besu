import { describe, expect, test } from 'vitest';
import type { ModelId } from '../../../server/src/domain.ts';
import type { Summary } from '../../../server/src/stats.ts';
import { clampCount, conclusion, minCapacity, showZetoWarning } from './stressForm.ts';

const s = (avgTps: number, ok = 10, p50Ms = 1000): Summary => ({ ok, failed: 0, avgTps, peakTps: avgTps, p50Ms, p95Ms: 2000, durationS: 5, series: [] });
const row = (model: ModelId, avg: number, ok = 10, p50Ms = 1000) => ({ model, s: s(avg, ok, p50Ms) });

describe('conclusion', () => {
  test('one model', () => {
    expect(conclusion([row('zeto', 1.5)])).toBe('Zeto: 1,5 TPS rata-rata.');
  });

  test('Zeto the slowest adds only its measured p50', () => {
    expect(conclusion([row('zeto', 1.5, 10, 2340), row('noto', 3), row('stealth', 8)])).toBe(
      'Stealth paling cepat dengan 8,0 TPS rata-rata, sekitar 5× Zeto. p50 Zeto 2,3 s.',
    );
  });

  test('no Zeto sentence when Zeto is not the slowest', () => {
    expect(conclusion([row('noto', 3), row('stealth', 9)])).toBe('Stealth paling cepat dengan 9,0 TPS rata-rata, sekitar 3× Noto.');
  });

  test('a zero-TPS worst model gets no ratio', () => {
    expect(conclusion([row('stealth', 4), row('noto', 0)])).toBe('Stealth paling cepat dengan 4,0 TPS rata-rata.');
  });

  test('a worst model with no successes gets no ratio and no p50', () => {
    expect(conclusion([row('stealth', 4), row('zeto', 0.4, 0, 0)])).toBe('Stealth paling cepat dengan 4,0 TPS rata-rata.');
  });
});

describe('clampCount', () => {
  test('caps at capacity', () => expect(clampCount(500, 200)).toBe(200));
  test('keeps a valid count', () => expect(clampCount(50, 200)).toBe(50));
  test('never below 1', () => expect(clampCount(0, 200)).toBe(1));
  test('NaN becomes 1', () => expect(clampCount(NaN, 200)).toBe(1));
});

describe('showZetoWarning', () => {
  test('zeto with 4 senders', () => expect(showZetoWarning(['zeto'], 4)).toBe(true));
  test('zeto with 2 senders', () => expect(showZetoWarning(['zeto'], 2)).toBe(false));
  test('noto with 8 senders', () => expect(showZetoWarning(['noto'], 8)).toBe(false));
});

describe('minCapacity', () => {
  test('smallest among selected models', () => {
    expect(minCapacity(['zeto', 'noto'], { zeto: 200, noto: 50, stealth: 900 })).toBe(50);
  });
  test('Infinity-free fallback when nothing selected', () => {
    expect(minCapacity([], { zeto: 200 })).toBe(0);
  });
});
