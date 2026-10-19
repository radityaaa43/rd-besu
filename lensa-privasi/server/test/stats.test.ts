import { expect, test } from 'vitest';
import { summarize, toCsv } from '../src/stats.ts';

test('basic', () => {
  const s = summarize([{ submittedAt: 0, confirmedAt: 500 }, { submittedAt: 0, confirmedAt: 1500 }, { submittedAt: 1000, confirmedAt: 1900 }, { submittedAt: 1000, confirmedAt: 2000 }], 1);
  expect(s).toEqual({ ok: 4, failed: 1, avgTps: 2, peakTps: 2, p50Ms: 900, p95Ms: 1500, durationS: 2, series: [1, 2, 1] });
});
test('empty', () => expect(summarize([], 3)).toEqual({ ok: 0, failed: 3, avgTps: 0, peakTps: 0, p50Ms: 0, p95Ms: 0, durationS: 0, series: [] }));
test('large run does not throw', () => {
  const samples = Array.from({ length: 300_000 }, (_, i) => ({ submittedAt: i, confirmedAt: i + 500 }));
  expect(summarize(samples, 0).ok).toBe(300_000);
});
test('csv',() => expect(toCsv([{ model: 'zeto', s: summarize([{ submittedAt: 0, confirmedAt: 1000 }], 0) }]))
  .toBe('model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s\nzeto,1.00,1.00,1.00,1.00,1,0,1.0'));
