// RED tests for the role-dependent keys (analyst verdict placement): the cert signer in the custodian namespace holds ONLY certKey,
// a bank signer holds spend/view/identity and never certKey.
import { describe, expect, it } from 'vitest';
import { loadKeys } from '../src/keys.ts';
import { createSigner } from '../src/server.ts';
import { A, CONFIG, FakeChain, start } from './fixtures.ts';

const files: Record<string, string> = { '/k/spendKey': '0xS', '/k/viewKey': '0xV', '/k/identityKey': '0xI', '/k/certKey': '0xC' };
const reader = (seen: string[]) => (path: string) => { seen.push(path); if (!(path in files)) throw new Error('ENOENT ' + path); return files[path] + '\n'; };

describe('loadKeys', () => {
  it('custodian reads certKey ONLY (never touches the bank key files)', () => {
    const seen: string[] = [];
    expect(loadKeys('custodian', '/k', reader(seen))).toEqual({ certKey: '0xC' });
    expect(seen).toEqual(['/k/certKey']);
  });
  it('bank reads spend/view/identity and never certKey', () => {
    const seen: string[] = [];
    expect(loadKeys('bank', '/k', reader(seen))).toEqual({ spendKey: '0xS', viewKey: '0xV', identityKey: '0xI' });
    expect(seen.sort()).toEqual(['/k/identityKey', '/k/spendKey', '/k/viewKey']);
  });
  it('a missing file is an error naming the file, not a silent default', () => {
    expect(() => loadKeys('custodian', '/nowhere', reader([]))).toThrow(/certKey/);
  });
});

describe('createSigner refuses a key set that does not match the role', () => {
  const deps = (keys: any) => ({ keys, chain: new FakeChain(), log: () => {} });
  const { metaAddress: _m, ...bank } = A;
  it('custodian with any bank key -> throws', () => {
    for (const extra of [{ spendKey: bank.spendKey }, { viewKey: bank.viewKey }, { identityKey: bank.identityKey }]) {
      expect(() => createSigner({ ...CONFIG, role: 'custodian' }, deps({ certKey: '0x' + '55'.repeat(32), ...extra }))).toThrow(/custodian/);
    }
  });
  it('custodian without certKey -> throws', () => {
    expect(() => createSigner({ ...CONFIG, role: 'custodian' }, deps({}))).toThrow(/certKey/);
  });
  it('bank with a certKey -> throws; bank missing a key -> throws', () => {
    expect(() => createSigner(CONFIG, deps({ ...bank, certKey: '0x' + '55'.repeat(32) }))).toThrow(/bank/);
    expect(() => createSigner(CONFIG, deps({ spendKey: bank.spendKey, viewKey: bank.viewKey }))).toThrow(/bank/);
  });
});

describe('custodian role serves only /cert and /health', () => {
  it('/intent, /holdings, /history -> 403 role_forbidden (it holds no spend/view key)', async () => {
    const s = await start(new FakeChain(), { cfg: { role: 'custodian' }, keys: { certKey: '0x' + '55'.repeat(32) } });
    try {
      for (const [m, p, b] of [['POST', '/intent', { kind: 'rd-transfer', from: 'A', to: { metaAddress: A.metaAddress }, amount: '1' }], ['GET', '/holdings'], ['GET', '/history']] as const) {
        const r = await s.call(m, p, b);
        expect([r.status, r.json.error]).toEqual([403, 'role_forbidden']);
      }
      expect((await s.call('GET', '/health')).status).toBe(200);
    } finally { await s.stop(); }
  });
});
