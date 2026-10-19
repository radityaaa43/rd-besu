import { describe, expect, it } from 'vitest';
import { checkOwnTx, outsiderVerdict } from '../src/adapters/stealth.ts';

describe('outsiderVerdict', () => {
  it('is partial only when the outsider matched nothing and could not open the memo', () => {
    expect(outsiderVerdict(0, null)).toBe('partial');
  });
  it('throws when the outsider matched an announcement', () => {
    expect(() => outsiderVerdict(1, null)).toThrow('Pihak luar ternyata bisa membaca transaksi');
  });
  it('throws when the outsider opened the memo', () => {
    expect(() => outsiderVerdict(0, { sender: '0x1' })).toThrow('Pihak luar ternyata bisa membaca transaksi');
  });
});

describe('checkOwnTx', () => {
  const ctx = { stealthAddress: '0xAbC', amount: 5n };
  it('accepts a matching on-chain announcement, case-insensitively', () => {
    expect(() => checkOwnTx(ctx, { stealthAddress: '0xabc', amount: 5n, token: '0xTOKEN' }, '0xtoken')).not.toThrow();
  });
  it.each([
    ['address', { stealthAddress: '0xdef', amount: 5n, token: '0xT' }],
    ['amount', { stealthAddress: '0xabc', amount: 6n, token: '0xT' }],
    ['token', { stealthAddress: '0xabc', amount: 5n, token: '0xOther' }],
  ])('throws when the on-chain %s differs', (_n, chain) => {
    expect(() => checkOwnTx(ctx, chain, '0xT')).toThrow('Data on-chain tidak cocok');
  });
});
