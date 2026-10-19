export type ModelId = 'zeto' | 'noto' | 'stealth';
export type FlowId = 'rd-issue' | 'rd-transfer' | 'dfabi-issue' | 'dfabi-transfer' | 'dvp';
export type PartyId = 'BI' | 'A' | 'B' | 'C';
export type BankId = Exclude<PartyId, 'BI'>;

export const PARTIES: Record<PartyId, { name: string; node: 1 | 2 | 3 | 4 }> = {
  BI: { name: 'Bank Indonesia', node: 1 },
  A: { name: 'Bank Mandala', node: 2 },
  B: { name: 'Bank Nusantara', node: 3 },
  C: { name: 'Bank Sejahtera', node: 4 },
};
export const BANKS: BankId[] = ['A', 'B', 'C'];
export const PRICE_PER_UNIT = 1_000_000n;
export const MAX_AMOUNT = 10n ** 15n;

export const FLOWS: Record<FlowId, { asset: 'RD' | 'DFABI'; issuer: boolean; dvp: boolean }> = {
  'rd-issue': { asset: 'RD', issuer: true, dvp: false },
  'rd-transfer': { asset: 'RD', issuer: false, dvp: false },
  'dfabi-issue': { asset: 'DFABI', issuer: true, dvp: false },
  'dfabi-transfer': { asset: 'DFABI', issuer: false, dvp: false },
  dvp: { asset: 'DFABI', issuer: false, dvp: true },
};

export interface FlowRequest { model: ModelId; flow: FlowId; from: PartyId; to: PartyId; amount: string }
export type Role = 'sender' | 'receiver' | 'issuer' | 'regulator' | 'outsider';

export function roleOf(req: FlowRequest, party: PartyId): Role {
  if (party === req.from) return FLOWS[req.flow].issuer ? 'issuer' : 'sender';
  if (party === req.to) return 'receiver';
  if (party === 'BI') return 'regulator';
  return 'outsider';
}

export function validateRequest(req: FlowRequest): { ok: true; amount: bigint } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const a = req.amount;
  if (a === '') return fail('Nominal wajib diisi');
  if (!/^\d+$/.test(a)) return fail('Nominal harus angka bulat');
  const amount = BigInt(a);
  if (amount < 1n) return fail('Nominal harus lebih dari 0');
  if (amount > MAX_AMOUNT) return fail('Nominal melebihi batas 1.000.000.000.000.000');
  if (req.from === req.to) return fail('Pengirim dan penerima harus berbeda');
  if (req.to === 'BI') return fail('Penerima harus bank');
  if (FLOWS[req.flow].issuer) { if (req.from !== 'BI') return fail('Penerbitan hanya dijalankan BI'); }
  else if (req.from === 'BI') return fail('Transfer dijalankan oleh bank');
  return { ok: true, amount };
}
export const MODEL_NAMES: Record<ModelId, string> = { zeto: 'Zeto', noto: 'Noto', stealth: 'Stealth' };
