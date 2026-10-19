import { MODEL_NAMES, type ModelId } from '../../../server/src/domain.ts';
import type { Summary } from '../../../server/src/stats.ts';
import { formatDecimal } from '../format.ts';

export const PRESETS: [string, number][] = [['Ringan', 50], ['Sedang', 200], ['Berat', 500]];
export const CONCURRENCY = [1, 2, 4, 8] as const;
export const LIMITS: [number, string][] = [[120, '2 menit'], [300, '5 menit'], [600, '10 menit']];

export const clampCount = (n: number, capacity: number): number =>
  Math.min(Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1, capacity);

export const minCapacity = (models: ModelId[], capacity: Partial<Record<ModelId, number>>): number =>
  models.length === 0 ? 0 : Math.min(...models.map((m) => capacity[m] ?? 0));

export const showZetoWarning = (models: ModelId[], concurrency: number): boolean =>
  models.includes('zeto') && concurrency > 2;

export function conclusion(rows: { model: ModelId; s: Summary }[]): string {
  const sorted = [...rows].sort((a, b) => b.s.avgTps - a.s.avgTps);
  const best = sorted[0], worst = sorted[sorted.length - 1];
  const avg = formatDecimal(best.s.avgTps);
  if (sorted.length === 1) return `${MODEL_NAMES[best.model]}: ${avg} TPS rata-rata.`;
  const name = MODEL_NAMES[best.model];
  // no ratio against a model that measured nothing
  if (worst.s.ok === 0 || worst.s.avgTps === 0) return `${name} paling cepat dengan ${avg} TPS rata-rata.`;
  const text = `${name} paling cepat dengan ${avg} TPS rata-rata, sekitar ${Math.round(best.s.avgTps / worst.s.avgTps)}× ${MODEL_NAMES[worst.model]}.`;
  return worst.model === 'zeto' ? `${text} p50 Zeto ${formatDecimal(worst.s.p50Ms / 1000)} s.` : text;
}
