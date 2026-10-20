import { describe, expect, test } from 'vitest';
import type { PartyId } from '../../../server/src/domain.ts';
import { counterpartyLine } from './counterparty.ts';

const name = (id: PartyId) => ({ BI: 'Bank Indonesia', A: 'Bank Mandala', B: 'Bank Nusantara', C: 'Bank Sejahtera' })[id];
const line = (role: 'sender' | 'receiver' | 'issuer' | 'regulator' | 'outsider', counterparty: { from: PartyId | null; to: PartyId | null } | null, dvp = false) =>
  counterpartyLine({ role, counterparty }, dvp, name);

describe('counterpartyLine', () => {
  test('regulator sees both banks by name', () => expect(line('regulator', { from: 'A', to: 'B' })).toBe('Bank Mandala → Bank Nusantara'));
  test('sender: ke', () => expect(line('sender', { from: 'A', to: 'B' })).toBe('ke Bank Nusantara'));
  test('receiver: dari', () => expect(line('receiver', { from: 'A', to: 'B' })).toBe('dari Bank Mandala'));
  test('dvp wording', () => {
    expect(line('sender', { from: 'A', to: 'B' }, true)).toBe('jual ke Bank Nusantara');
    expect(line('receiver', { from: 'A', to: 'B' }, true)).toBe('beli dari Bank Mandala');
  });
  test('issuer', () => expect(line('issuer', { from: 'BI', to: 'B' })).toBe('diterbitkan untuk Bank Nusantara'));
  test('null counterparty and unreadable side', () => {
    expect(line('outsider', null)).toBe('Pihak tidak terbaca');
    expect(line('receiver', { from: null, to: 'B' })).toBe('Pengirim tidak tercantum di UTXO');
    expect(line('regulator', { from: 'A', to: null })).toBe('Bank Mandala → tidak terbaca');
  });
});
