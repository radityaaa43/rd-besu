import { readFileSync, readdirSync } from 'node:fs';
import { scanView } from '../../ts/stealth.ts';
import type { BankKeys, BiKeys, CustodianKeys, Keys } from './types.ts';

// Role-dependent key loading (analyst verdict placement): the custodian reads certKey ONLY, a bank reads spend/view/identity and never certKey,
// BI reads issuerKey, its own spend/view and the per-bank view copies (viewcopies/<id>.viewKey + <id>.metaAddress), never certKey.
export function loadKeys(role: 'custodian', dir: string, read?: (p: string) => string): CustodianKeys;
export function loadKeys(role: 'bank', dir: string, read?: (p: string) => string): BankKeys;
export function loadKeys(role: 'bi', dir: string, read?: (p: string) => string, list?: (dir: string) => string[]): BiKeys;
export function loadKeys(role: 'bank' | 'custodian' | 'bi', dir: string, read?: (p: string) => string, list?: (dir: string) => string[]): Keys;
export function loadKeys(role: 'bank' | 'custodian' | 'bi', dir: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8'), list: (dir: string) => string[] = (d) => readdirSync(d)): Keys {
  const get = (name: string) => {
    try { return read(`${dir}/${name}`).trim(); } catch { throw new Error(`key file ${name} missing or unreadable in ${dir}`); }
  };
  if (role === 'custodian') return { certKey: get('certKey') };
  if (role === 'bi') {
    const ids = list(`${dir}/viewcopies`).filter((n) => n.endsWith('.viewKey')).map((n) => n.slice(0, -'.viewKey'.length)).sort();
    const viewCopies = ids.map((id) => ({ id, viewKey: get(`viewcopies/${id}.viewKey`), metaAddress: get(`viewcopies/${id}.metaAddress`) }));
    for (const h of viewCopies) scanView([], h); // refuses a view key that does not belong to its meta-address, naming the bank
    return { issuerKey: get('issuerKey'), spendKey: get('spendKey'), viewKey: get('viewKey'), viewCopies };
  }
  return { spendKey: get('spendKey'), viewKey: get('viewKey'), identityKey: get('identityKey') };
}
