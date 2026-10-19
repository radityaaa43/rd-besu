import { describe, expect, test } from 'vitest';
import type { ModelId } from '../../../server/src/domain.ts';
import type { Summary } from '../../../server/src/stats.ts';
import { clampCount, conclusion, minCapacity, showZetoWarning } from './stressForm.ts';

const s = (avgTps: number): Summary => ({ ok: 10, failed: 0, avgTps, peakTps: avgTps, p50Ms: 1000, p95Ms: 2000, durationS: 5, series: [] });
const row = (model: ModelId, avg: number) => ({ model, s: s(avg) });

describe('conclusion', () => {
  test('one model', () => {
    expect(conclusion([row('zeto', 1.5)])).toBe('Zeto: 1,5 TPS rata-rata.');
  });

  test('three models with Zeto the slowest', () => {
    expect(conclusion([row('zeto', 1.5), row('noto', 3), row('stealth', 8)])).toBe(
      'Stealth paling cepat dengan 8,0 TPS rata-rata, sekitar 5× Zeto. Zeto lebih lambat karena setiap transaksi harus membangun bukti ZK (~2 detik).',
    );
  });

  test('no Zeto sentence when Zeto is not the slowest', () => {
    expect(conclusion([row('noto', 3), row('stealth', 9)])).toBe('Stealth paling cepat dengan 9,0 TPS rata-rata, sekitar 3× Noto.');
  });

  test('a zero-TPS worst model does not divide by zero', () => {
    expect(conclusion([row('stealth', 4), row('noto', 0)])).toMatch(/^Stealth paling cepat dengan 4,0 TPS rata-rata, sekitar \d+× Noto\.$/);
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
