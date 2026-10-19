const ID = 'id-ID';
const n = (v: bigint | number, max = 2) => new Intl.NumberFormat(ID, { maximumFractionDigits: max }).format(v);

export const formatRupiah = (v: bigint): string => `Rp ${n(v)}`;
export const formatUnits = (v: bigint): string => `${n(v)} unit DFABI`;

// amounts are capped at 1e15 server-side, so Number() is exact for the scaled value
export function amountWords(v: bigint, asset: 'RD' | 'DFABI'): string {
  if (asset !== 'RD') return `${n(v)} unit`;
  if (v >= 10n ** 12n) return `${n(Number(v) / 1e12)} triliun rupiah`;
  if (v >= 10n ** 9n) return `${n(Number(v) / 1e9)} miliar rupiah`;
  if (v >= 10n ** 6n) return `${n(Number(v) / 1e6)} juta rupiah`;
  return `${n(v)} rupiah`;
}

export const formatDecimal = (x: number, digits = 1): string =>
  x.toLocaleString(ID, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const formatSeconds = (ms: number): string => `${formatDecimal(ms / 1000, 2)} s`;
export const shortHash = (h: string): string => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h);

export function parseAmountInput(s: string): bigint | null {
  const digits = s.replace(/\D/g, '');
  return digits === '' ? null : BigInt(digits);
}
