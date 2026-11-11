// S10 `ROLE=bi` (PLAN S10, design approved by default): BI signer = issuer key (mint, DFABI issue), BI's own receive keys, and a detective ledger
// scan with per-bank VIEW-key copies (never a spend key). RED first: role bi does not exist yet.
import { Interface, Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBondMetadata } from '../../ts/bond.ts';
import { TRANCHE_A, pay } from '../../ts/chain.ts';
import { metaAddressOf, scan } from '../../ts/stealth.ts';
import { buildTokenMetadata } from '../../ts/token.ts';
import { loadKeys } from '../src/keys.ts';
import { createSigner } from '../src/server.ts';
import { A, B, BOND, CHAIN_ID, CONFIG, FakeChain, RD, decodeRaw, fund, start } from './fixtures.ts';

const BI_SPEND = '0x' + '31'.repeat(32), BI_VIEW = '0x' + '32'.repeat(32), ISSUER = '0x' + '99'.repeat(32);
const BI_META = metaAddressOf(BI_SPEND, BI_VIEW);
const COPIES = [{ id: 'A', viewKey: A.viewKey, metaAddress: A.metaAddress }, { id: 'B', viewKey: B.viewKey, metaAddress: B.metaAddress }];
const biKeys = { issuerKey: ISSUER, spendKey: BI_SPEND, viewKey: BI_VIEW, viewCopies: COPIES };
const biCfg = { role: 'bi' as const, party: 'BI' };
const issuerAddr = new Wallet(ISSUER).address;
const rdAbi = new Interface(['function mintStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)']);
const bondAbi = new Interface(['function issueByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)']);

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
const startBi = async (chain = new FakeChain()) => { const s = await start(chain, { cfg: biCfg, keys: biKeys as any }); stop = s.stop; return s; };

describe('loadKeys role bi', () => {
  const files: Record<string, string> = {
    '/k/issuerKey': ISSUER, '/k/spendKey': BI_SPEND, '/k/viewKey': BI_VIEW,
    '/k/viewcopies/A.viewKey': A.viewKey, '/k/viewcopies/A.metaAddress': A.metaAddress, '/k/viewcopies/B.viewKey': B.viewKey, '/k/viewcopies/B.metaAddress': B.metaAddress,
    '/k/certKey': '0xC',
  };
  const read = (seen: string[]) => (p: string) => { seen.push(p); if (!(p in files)) throw new Error('ENOENT ' + p); return files[p] + '\n'; };
  const list = (d: string) => Object.keys(files).filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1));
  it('reads issuer, own receive keys and every bank view copy; never certKey; never a bank spend key', () => {
    const seen: string[] = [];
    const k: any = loadKeys('bi', '/k', read(seen), list);
    expect(k).toEqual(biKeys);
    expect(seen.some((p) => p.endsWith('certKey'))).toBe(false);
  });
  it('a missing issuerKey is an error naming the file', () => {
    const f = { ...files }; delete f['/k/issuerKey'];
    expect(() => loadKeys('bi', '/k', (p) => { if (!(p in f)) throw new Error('ENOENT'); return f[p]; }, list)).toThrow(/issuerKey/);
  });
  it('a view copy that does not match its meta-address is refused, naming the bank', () => {
    const f: Record<string, string> = { ...files, '/k/viewcopies/A.viewKey': B.viewKey };
    expect(() => loadKeys('bi', '/k', (p) => { if (!(p in f)) throw new Error('ENOENT'); return f[p]; }, list)).toThrow(/view key does not match meta-address of A/);
  });
});

describe('loadKeys role bi, view copies from a separate directory (K8s: optional Secret mounted at its own path)', () => {
  const files: Record<string, string> = {
    '/k/issuerKey': ISSUER, '/k/spendKey': BI_SPEND, '/k/viewKey': BI_VIEW,
    '/c/A.viewKey': A.viewKey, '/c/A.metaAddress': A.metaAddress, '/c/B.viewKey': B.viewKey, '/c/B.metaAddress': B.metaAddress,
  };
  const rd = (f: Record<string, string>, seen: string[] = []) => (p: string) => { seen.push(p); if (!(p in f)) throw new Error('ENOENT ' + p); return f[p] + '\n'; };
  const ls = (f: Record<string, string>) => (d: string) => {
    const n = Object.keys(f).filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1));
    if (!n.length) throw Object.assign(new Error('ENOENT ' + d), { code: 'ENOENT' });
    return n;
  };
  it('reads the copies from copiesDir, not from ${dir}/viewcopies', () => {
    const seen: string[] = [];
    const k: any = loadKeys('bi', '/k', rd(files, seen), ls(files), '/c');
    expect(k).toEqual(biKeys);
    expect(seen).toContain('/c/A.viewKey');
    expect(seen).toContain('/c/B.metaAddress');
    expect(seen.some((p) => p.includes('viewcopies'))).toBe(false);
  });
  it('an absent copies directory (ENOENT) means no copies, not an error', () => {
    const f = { '/k/issuerKey': ISSUER, '/k/spendKey': BI_SPEND, '/k/viewKey': BI_VIEW };
    expect((loadKeys('bi', '/k', rd(f), ls(f), '/c') as any).viewCopies).toEqual([]);
    expect((loadKeys('bi', '/k', rd(f), ls(f)) as any).viewCopies).toEqual([]);
  });
  it('any other list error stays fatal', () => {
    const f = { '/k/issuerKey': ISSUER, '/k/spendKey': BI_SPEND, '/k/viewKey': BI_VIEW };
    const eacces = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    expect(() => loadKeys('bi', '/k', rd(f), eacces, '/c')).toThrow(/EACCES/);
  });
  it('an unreadable copy file and a mismatching copy in the custom dir are still refused', () => {
    const noMeta = { ...files }; delete noMeta['/c/A.metaAddress'];
    expect(() => loadKeys('bi', '/k', rd(noMeta), ls(noMeta), '/c')).toThrow(/A\.metaAddress/);
    const bad = { ...files, '/c/A.viewKey': B.viewKey };
    expect(() => loadKeys('bi', '/k', rd(bad), ls(bad), '/c')).toThrow(/view key does not match meta-address of A/);
  });
  it('the signer with no copies answers GET /ledger?kind=rd with rows: []', async () => {
    const f = { '/k/issuerKey': ISSUER, '/k/spendKey': BI_SPEND, '/k/viewKey': BI_VIEW };
    const keys = loadKeys('bi', '/k', rd(f), ls(f), '/c');
    const chain = new FakeChain(); fund(chain, 'rd', 500n, 5);
    const s = await start(chain, { cfg: biCfg, keys: keys as any }); stop = s.stop;
    const r = await s.call('GET', '/ledger?kind=rd');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ kind: 'rd', rows: [] });
  });
});

describe('createSigner key sets per role', () => {
  const deps = (keys: any) => ({ keys, chain: new FakeChain(), log: () => {} });
  it('role bi needs exactly {issuerKey, spendKey, viewKey, viewCopies}', () => {
    expect(() => createSigner({ ...CONFIG, ...biCfg }, deps(biKeys))).not.toThrow();
    expect(() => createSigner({ ...CONFIG, ...biCfg }, deps({ ...biKeys, certKey: '0x' + '55'.repeat(32) }))).toThrow(/bi/);
    expect(() => createSigner({ ...CONFIG, ...biCfg }, deps({ spendKey: A.spendKey, viewKey: A.viewKey, identityKey: A.identityKey }))).toThrow(/bi/);
  });
  it('role bank refuses the BI key set', () => {
    expect(() => createSigner(CONFIG, deps(biKeys))).toThrow(/bank/);
  });
});

describe('GET /meta-address (role bi)', () => {
  it('BI own receive meta-address and the issuer account', async () => {
    const s = await startBi();
    const r = await s.call('GET', '/meta-address');
    expect(r.json).toEqual({ party: 'BI', metaAddress: BI_META, identityAddress: issuerAddr });
  });
});

describe('POST /intent rd-mint and bond-issue (issuer key)', () => {
  it('rd-mint: signed by the issuer account, mintStealth to the receiver; the receiver scans it', async () => {
    const chain = new FakeChain(); const s = await startBi(chain);
    const r = await s.call('POST', '/intent', { kind: 'rd-mint', from: 'BI', to: { metaAddress: A.metaAddress }, amount: '1000' });
    expect(r.status).toBe(200);
    const tx = decodeRaw(r.json.rawTx);
    expect(tx.from).toBe(issuerAddr);
    expect(tx.to?.toLowerCase()).toBe(RD.toLowerCase());
    expect(tx.chainId).toBe(CHAIN_ID);
    const [receiver, amount, eph, tag, memo] = rdAbi.decodeFunctionData('mintStealth', tx.data);
    expect(amount).toBe(1000n);
    const ann = { schemeId: 1n, stealthAddress: receiver, ephemeralPubKey: eph, metadata: buildTokenMetadata(tag, RD, 1000n, memo) };
    expect(scan([ann], A.viewKey, A.spendKey).map((f) => f.stealthAddress)).toEqual([receiver]);
    expect(chain.sent).toEqual([r.json.rawTx]);
    expect(r.json.from).toBe(issuerAddr);
  });
  it('bond-issue: issueByPartitionStealth on the bond, default partition TRANCHE_A, no certificate call', async () => {
    const chain = new FakeChain(); const s = await startBi(chain);
    const r = await s.call('POST', '/intent', { kind: 'bond-issue', from: 'BI', to: { metaAddress: B.metaAddress }, amount: '7' });
    expect(r.status).toBe(200);
    const tx = decodeRaw(r.json.rawTx);
    expect([tx.from, tx.to?.toLowerCase()]).toEqual([issuerAddr, BOND.toLowerCase()]);
    const [partition, receiver, value, eph, tag, memo] = bondAbi.decodeFunctionData('issueByPartitionStealth', tx.data);
    expect([partition, value]).toEqual([TRANCHE_A, 7n]);
    const ann = { schemeId: 1n, stealthAddress: receiver, ephemeralPubKey: eph, metadata: buildBondMetadata(tag, BOND, 7n, TRANCHE_A, memo) };
    expect(scan([ann], B.viewKey, B.spendKey).map((f) => f.stealthAddress)).toEqual([receiver]);
  });
  it('another party id -> 403 wrong_party, nothing sent', async () => {
    const chain = new FakeChain(); const s = await startBi(chain);
    const r = await s.call('POST', '/intent', { kind: 'rd-mint', from: 'A', to: { metaAddress: A.metaAddress }, amount: '1' });
    expect([r.status, r.json.error]).toEqual([403, 'wrong_party']);
    expect(chain.sent).toEqual([]);
  });
  it('bad meta-address and bad amount are rejected before anything is signed', async () => {
    const chain = new FakeChain(); const s = await startBi(chain);
    expect((await s.call('POST', '/intent', { kind: 'rd-mint', from: 'BI', to: { metaAddress: '0x12' }, amount: '1' })).json.error).toBe('bad_meta_address');
    expect((await s.call('POST', '/intent', { kind: 'rd-mint', from: 'BI', to: { metaAddress: A.metaAddress }, amount: '0' })).json.error).toBe('bad_amount');
    expect(chain.sent).toEqual([]);
  });
  it('a bank signer cannot mint or issue: 403 role_forbidden', async () => {
    const s = await start(new FakeChain()); stop = s.stop;
    for (const kind of ['rd-mint', 'bond-issue']) {
      const r = await s.call('POST', '/intent', { kind, from: 'A', to: { metaAddress: B.metaAddress }, amount: '1' });
      expect([r.status, r.json.error]).toEqual([403, 'role_forbidden']);
    }
  });
});

describe('GET /holdings and /history (role bi, own receive keys)', () => {
  it('BI sees what was paid to its own meta-address', async () => {
    const chain = new FakeChain();
    const p = pay(CHAIN_ID, BI_META, '0x' + '77'.repeat(32), RD, 250n);
    chain.anns.push({ schemeId: 1n, stealthAddress: p.s.stealthAddress, ephemeralPubKey: p.s.ephemeralPubKey, metadata: buildTokenMetadata(p.s.viewTag, RD, 250n, p.memo), txHash: '0x' + '1'.padStart(64, '0'), blockNumber: 1, caller: RD });
    chain.balances.set((RD + p.s.stealthAddress).toLowerCase(), 250n);
    const s = await startBi(chain);
    const h = await s.call('GET', '/holdings');
    expect(h.json.party).toBe('BI');
    expect(h.json.holdings.map((x: any) => [x.stealthAddress, x.amount])).toEqual([[p.s.stealthAddress, '250']]);
  });
});

describe('GET /ledger (BI detective view from per-bank view copies)', () => {
  it('rows per bank for rd and bond; unknown recipients are absent; no private key anywhere', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 500n, 5); fund(chain, 'bond', 9n, 6);
    const s = await startBi(chain);
    const rd = await s.call('GET', '/ledger?kind=rd');
    expect(rd.status).toBe(200);
    expect(rd.json.rows.map((r: any) => [r.bank, r.amount])).toEqual([['A', '500']]);
    const bond = await s.call('GET', '/ledger?kind=bond');
    expect(bond.json.rows.map((r: any) => [r.bank, r.amount])).toEqual([['A', '9']]);
    expect((await s.call('GET', '/ledger?kind=nope')).status).toBe(422);
    for (const k of [A.spendKey, A.viewKey, B.viewKey, BI_SPEND, BI_VIEW, ISSUER]) {
      expect(s.rec.bodies.join('').toLowerCase()).not.toContain(k.slice(2));
      expect(s.rec.logs.join('\n').toLowerCase()).not.toContain(k.slice(2));
    }
  });
  it('bank and custodian signers have no ledger: 403 role_forbidden', async () => {
    const b = await start(new FakeChain()); stop = b.stop;
    expect([(await b.call('GET', '/ledger?kind=rd')).status]).toEqual([403]);
    await b.stop();
    const c = await start(new FakeChain(), { cfg: { role: 'custodian' }, keys: { certKey: '0x' + '55'.repeat(32) } }); stop = c.stop;
    expect([(await c.call('GET', '/ledger?kind=rd')).status]).toEqual([403]);
  });
});

describe('/cert on role bi', () => {
  it('403 role_forbidden: the cert key lives in the custodian pod only', async () => {
    const s = await startBi();
    const r = await s.call('POST', '/cert', {});
    expect([r.status, r.json.error]).toEqual([403, 'role_forbidden']);
  });
});
