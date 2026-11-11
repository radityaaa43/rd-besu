import { readFileSync, readdirSync } from 'node:fs';
import { scanView } from '../../ts/stealth.ts';
import type { BankKeys, BiKeys, CustodianKeys, Keys } from './types.ts';

// Role-dependent key loading (analyst verdict placement): the custodian reads certKey ONLY, a bank reads spend/view/identity and never certKey,
// BI reads issuerKey, its own spend/view and the per-bank view copies (viewcopies/<id>.viewKey + <id>.metaAddress), never certKey.
export function loadKeys(role: 'custodian', dir: string, read?: (p: string) => string): CustodianKeys;
export function loadKeys(role: 'bank', dir: string, read?: (p: string) => string): BankKeys;
export function loadKeys(role: 'bi', dir: string, read?: (p: string) => string, list?: (dir: string) => string[], copiesDir?: string): BiKeys;
export function loadKeys(role: 'bank' | 'custodian' | 'bi', dir: string, read?: (p: string) => string, list?: (dir: string) => string[], copiesDir?: string): Keys;
export function loadKeys(role: 'bank' | 'custodian' | 'bi', dir: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8'), list: (dir: string) => string[] = (d) => readdirSync(d), copiesDir = `${dir}/viewcopies`): Keys {
  const at = (path: string, name: string, where: string) => {
    try { return read(path).trim(); } catch { throw new Error(`key file ${name} missing or unreadable in ${where}`); }
  };
  const get = (name: string) => at(`${dir}/${name}`, name, dir);
  if (role === 'custodian') return { certKey: get('certKey') };
  if (role === 'bi') {
    // An absent copies directory (ENOENT: the optional K8s Secret is not filled yet) means no copies; every other error stays fatal.
    let names: string[];
    try { names = list(copiesDir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; names = []; }
    const ids = names.filter((n) => n.endsWith('.viewKey')).map((n) => n.slice(0, -'.viewKey'.length)).sort();
    const viewCopies = ids.map((id) => ({ id, viewKey: at(`${copiesDir}/${id}.viewKey`, `${id}.viewKey`, copiesDir), metaAddress: at(`${copiesDir}/${id}.metaAddress`, `${id}.metaAddress`, copiesDir) }));
    for (const h of viewCopies) scanView([], h); // refuses a view key that does not belong to its meta-address, naming the bank
    return { issuerKey: get('issuerKey'), spendKey: get('spendKey'), viewKey: get('viewKey'), viewCopies };
  }
  return { spendKey: get('spendKey'), viewKey: get('viewKey'), identityKey: get('identityKey') };
}
