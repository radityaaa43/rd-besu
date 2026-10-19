import { expect, test } from 'vitest';
import { roleOf, validateRequest, type FlowRequest } from '../src/domain.ts';

const t = (o: Partial<FlowRequest>): FlowRequest => ({ model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000', ...o });

test('transfer roles', () => {
  expect(roleOf(t({}), 'A')).toBe('sender'); expect(roleOf(t({}), 'B')).toBe('receiver');
  expect(roleOf(t({}), 'BI')).toBe('regulator'); expect(roleOf(t({}), 'C')).toBe('outsider');
});
test('issue roles', () => {
  const r = t({ flow: 'rd-issue', from: 'BI', to: 'C' });
  expect(roleOf(r, 'BI')).toBe('issuer'); expect(roleOf(r, 'C')).toBe('receiver');
  expect(roleOf(r, 'A')).toBe('outsider'); expect(roleOf(r, 'B')).toBe('outsider');
});
test.each([
  [{ amount: '' }, 'Nominal wajib diisi'],
  [{ amount: '0' }, 'Nominal harus lebih dari 0'],
  [{ amount: '12a' }, 'Nominal harus angka bulat'],
  [{ amount: '1000000000000001' }, 'Nominal melebihi batas 1.000.000.000.000.000'],
  [{ to: 'A' }, 'Pengirim dan penerima harus berbeda'],
  [{ to: 'BI' }, 'Penerima harus bank'],
  [{ flow: 'rd-issue', from: 'A' }, 'Penerbitan hanya dijalankan BI'],
  [{ flow: 'rd-transfer', from: 'BI' }, 'Transfer dijalankan oleh bank'],
] as [Partial<FlowRequest>, string][])('rejects %o', (o, reason) => expect(validateRequest(t(o))).toEqual({ ok: false, reason }));
test('accepts and parses', () => expect(validateRequest(t({ amount: '1000000000' }))).toEqual({ ok: true, amount: 1_000_000_000n }));
