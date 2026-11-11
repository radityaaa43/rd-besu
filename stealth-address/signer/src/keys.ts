import { readFileSync } from 'node:fs';
import type { BankKeys, CustodianKeys } from './types.ts';

// Role-dependent key loading (analyst verdict placement): the custodian reads certKey ONLY, a bank reads spend/view/identity and never certKey.
export function loadKeys(role: 'custodian', dir: string, read?: (p: string) => string): CustodianKeys;
export function loadKeys(role: 'bank', dir: string, read?: (p: string) => string): BankKeys;
export function loadKeys(role: 'bank' | 'custodian', dir: string, read?: (p: string) => string): BankKeys | CustodianKeys;
export function loadKeys(role: 'bank' | 'custodian', dir: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): BankKeys | CustodianKeys {
  const get = (name: string) => {
    try { return read(`${dir}/${name}`).trim(); } catch { throw new Error(`key file ${name} missing or unreadable in ${dir}`); }
  };
  if (role === 'custodian') return { certKey: get('certKey') };
  return { spendKey: get('spendKey'), viewKey: get('viewKey'), identityKey: get('identityKey') };
}
