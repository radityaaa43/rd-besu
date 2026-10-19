import { describe, expect, it } from 'vitest';
import { outsiderVerdict } from '../src/adapters/stealth.ts';

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
