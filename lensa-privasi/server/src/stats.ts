export interface Sample { submittedAt: number; confirmedAt: number }
export interface Summary { ok: number; failed: number; avgTps: number; peakTps: number; p50Ms: number; p95Ms: number; durationS: number; series: number[] }

export function summarize(samples: Sample[], failed: number): Summary {
  const ok = samples.length;
  if (!ok) return { ok: 0, failed, avgTps: 0, peakTps: 0, p50Ms: 0, p95Ms: 0, durationS: 0, series: [] };
  let t0 = Infinity, tEnd = -Infinity;
  for (const s of samples) { if (s.submittedAt < t0) t0 = s.submittedAt; if (s.confirmedAt > tEnd) tEnd = s.confirmedAt; }
  const durationS = (tEnd - t0) / 1000;
  const series: number[] = new Array(Math.floor((tEnd - t0) / 1000) + 1).fill(0);
  for (const s of samples) series[Math.floor((s.confirmedAt - t0) / 1000)]++;
  const lat = samples.map((s) => s.confirmedAt - s.submittedAt).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.ceil(p * ok) - 1];
  return { ok, failed, avgTps: durationS ? ok / durationS : 0, peakTps: series.reduce((m, n) => (n > m ? n : m), 0), p50Ms: pct(0.5), p95Ms: pct(0.95), durationS, series };
}

export function toCsv(rows: { model: string; s: Summary }[]): string {
  const head = 'model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s';
  const f2 = (n: number) => n.toFixed(2);
  return [head, ...rows.map(({ model, s }) =>
    [model, f2(s.avgTps), f2(s.peakTps), f2(s.p50Ms / 1000), f2(s.p95Ms / 1000), s.ok, s.failed, s.durationS.toFixed(1)].join(','))].join('\n');
}
