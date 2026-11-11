// S11 DELTA 3: BI compares the viewing public key inside each party's registered meta-address (ERC-6538 registry) with its own view-key copy.
import { JsonRpcProvider, Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { PARTIES, compareViewKeys, exitCode, formatRow, guardProvider, readOnlySend, summaryLine, type CompareBank, type CompareRow } from '../src/compare.ts';
import { createProvider } from '../src/chainPort.ts';
import { loadViewCopiesWithIdentity } from '../src/keys.ts';
import { A, B } from './fixtures.ts';
import { generateMetaAddress } from '../../ts/stealth.ts';

const C = generateMetaAddress();
const BI = generateMetaAddress();
const keyOf = (n: string) => '0x' + n.repeat(32);
const sets = { 'bi': { ...BI, identityKey: keyOf('66') }, 'bank-a': A, 'bank-b': { ...B, identityKey: keyOf('55') }, 'bank-c': { ...C, identityKey: keyOf('88') } };
const bank = (id: keyof typeof sets): CompareBank => ({ id, identityAddress: new Wallet(sets[id].identityKey).address, viewKey: sets[id].viewKey, metaAddress: sets[id].metaAddress });
const banks: CompareBank[] = PARTIES.map((id) => bank(id as keyof typeof sets)); // exactly the four parties, in PARTIES order
const idOf = (id: keyof typeof sets) => bank(id).identityAddress;
const reg = (m: Record<string, string | null>) => async (id: string) => m[id] ?? null;
const registered = Object.fromEntries(banks.map((b) => [b.identityAddress, b.metaAddress]));
const secrets = Object.values(sets).flatMap((k) => [k.spendKey, k.viewKey, k.identityKey]).map((k) => k.slice(2).toLowerCase());
const noKey = (s: string) => { for (const k of secrets) expect(s.toLowerCase()).not.toContain(k); };
const statuses = (rows: CompareRow[]) => rows.map((r) => r.status);

describe('PARTIES', () => {
  it('exactly bi, bank-a, bank-b, bank-c in this order', () => { expect(PARTIES).toEqual(['bi', 'bank-a', 'bank-b', 'bank-c']); });
});

describe('compareViewKeys', () => {
  it('all four parties registered with their own meta-address -> OK x4, lines in fixed order, exit 0', async () => {
    const rows = await compareViewKeys({ registry: reg(registered), banks });
    expect(rows.map(formatRow)).toEqual(['OK bi', 'OK bank-a', 'OK bank-b', 'OK bank-c']);
    expect(exitCode(rows)).toBe(0);
    expect(summaryLine(rows)).toBe('compare: 4/4 OK');
  });
  it('rows follow PARTIES order whatever the order of the copies', async () => {
    const rows = await compareViewKeys({ registry: reg(registered), banks: [...banks].reverse() });
    expect(rows.map((r) => r.bank)).toEqual(PARTIES);
  });
  it('registry holds the meta-address of ANOTHER party -> MISMATCH naming the bank, exit 1', async () => {
    const rows = await compareViewKeys({ registry: reg({ ...registered, [idOf('bank-b')]: A.metaAddress }), banks });
    expect(statuses(rows)).toEqual(['OK', 'OK', 'MISMATCH', 'OK']);
    expect(rows[2].bank).toBe('bank-b');
    expect(rows[2].detail).toContain(idOf('bank-b'));
    expect(exitCode(rows)).toBe(1);
    expect(summaryLine(rows)).toBe('compare: FAIL (1 not OK)');
  });
  it('registry empty (null, "", 0x) -> `unregistered <id>`, exit 1', async () => {
    for (const empty of [null, '', '0x']) {
      const rows = await compareViewKeys({ registry: reg({ ...registered, [idOf('bank-a')]: empty }), banks });
      expect(rows.map(formatRow)).toEqual(['OK bi', 'unregistered bank-a', 'OK bank-b', 'OK bank-c']);
      expect(exitCode(rows)).toBe(1);
    }
  });
  it('registry value of the wrong length (or not hex) -> MISMATCH, exit 1', async () => {
    const short = await compareViewKeys({ registry: reg({ ...registered, [idOf('bank-a')]: A.metaAddress.slice(0, -2) }), banks });
    expect(short[1]).toMatchObject({ status: 'MISMATCH' });
    expect(short[1].detail).toContain('65');
    const junk = await compareViewKeys({ registry: reg({ ...registered, [idOf('bank-a')]: '0xzz' }), banks });
    expect(junk[1].status).toBe('MISMATCH');
    expect(exitCode(junk)).toBe(1);
  });
  it('held view key does not belong to the held meta-address -> bad_copy; held meta not 66 bytes -> bad_copy; exit 1', async () => {
    const wrongKey = { ...bank('bank-a'), viewKey: B.viewKey };
    const shortMeta = { ...bank('bank-b'), metaAddress: B.metaAddress.slice(0, -2) };
    const rows = await compareViewKeys({ registry: reg(registered), banks: [bank('bi'), wrongKey, shortMeta, bank('bank-c')] });
    expect(statuses(rows)).toEqual(['OK', 'bad_copy', 'bad_copy', 'OK']);
    rows.forEach((r) => noKey(r.detail));
    expect(exitCode(rows)).toBe(1);
  });
  it('registry replaced after being registered flips OK -> MISMATCH', async () => {
    let current = A.metaAddress;
    const registry = async (id: string) => (id === idOf('bank-a') ? current : registered[id]);
    expect(statuses(await compareViewKeys({ registry, banks }))[1]).toBe('OK');
    current = B.metaAddress;
    expect(statuses(await compareViewKeys({ registry, banks }))[1]).toBe('MISMATCH');
  });
  it('only the viewing part counts: another spend part with the same view part is still OK', async () => {
    const other = '0x' + B.metaAddress.slice(2, 2 + 66) + A.metaAddress.slice(2 + 66);
    const rows = await compareViewKeys({ registry: reg({ ...registered, [idOf('bank-a')]: other }), banks });
    expect(rows[1].status).toBe('OK');
  });
  it('a missing party (3 copies only) -> `missing_copy <id>` for it, exit 1', async () => {
    const rows = await compareViewKeys({ registry: reg(registered), banks: banks.filter((b) => b.id !== 'bank-c') });
    expect(rows.map(formatRow)).toEqual(['OK bi', 'OK bank-a', 'OK bank-b', 'missing_copy bank-c']);
    expect(exitCode(rows)).toBe(1);
    expect(summaryLine(rows)).toBe('compare: FAIL (1 not OK)');
  });
  it('empty directory (no copies) -> four missing_copy lines, exit 1, the registry is never read', async () => {
    const registry = vi.fn(async () => null);
    const rows = await compareViewKeys({ registry, banks: [] });
    expect(rows.map(formatRow)).toEqual(['missing_copy bi', 'missing_copy bank-a', 'missing_copy bank-b', 'missing_copy bank-c']);
    expect(exitCode(rows)).toBe(1);
    expect(summaryLine(rows)).toBe('compare: FAIL (4 not OK)');
    expect(registry).not.toHaveBeenCalled();
  });
  it('an extra copy id is printed as `ignored <id>`, never OK, and does not change the exit code', async () => {
    const extra: CompareBank = { ...bank('bank-a'), id: 'bank-d' };
    const rows = await compareViewKeys({ registry: reg(registered), banks: [...banks, extra] });
    expect(rows.map(formatRow)).toEqual(['OK bi', 'OK bank-a', 'OK bank-b', 'OK bank-c', 'ignored bank-d']);
    expect(exitCode(rows)).toBe(0);
    expect(summaryLine(rows)).toBe('compare: 4/4 OK');
    // an ignored copy cannot stand in for a missing party
    const only = await compareViewKeys({ registry: reg(registered), banks: [extra] });
    expect(exitCode(only)).toBe(1);
  });
  it('the registry read throws for ONE party -> registry_error for it, the others are still evaluated', async () => {
    const registry = async (id: string) => { if (id === idOf('bank-a')) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); return registered[id]; };
    const rows = await compareViewKeys({ registry, banks });
    expect(rows[1]).toMatchObject({ bank: 'bank-a', status: 'registry_error' });
    expect(rows[1].detail).toContain('ECONNREFUSED');
    expect(statuses(rows)).toEqual(['OK', 'registry_error', 'OK', 'OK']);
    expect(exitCode(rows)).toBe(1);
  });
  it('the registry read throws for ALL parties -> registry_error x4, never OK, exit 1', async () => {
    const rows = await compareViewKeys({ registry: async () => { throw new Error('rpc down'); }, banks });
    expect(statuses(rows)).toEqual(Array(4).fill('registry_error'));
    expect(exitCode(rows)).toBe(1);
  });
  it('error text is scrubbed (0x + 64 hex -> 0x<redacted>) and truncated to 80 chars', async () => {
    const leak = '0x' + A.spendKey.slice(2);
    const rows = await compareViewKeys({ registry: async () => { throw new Error(`bad request key=${leak} ${A.viewKey.slice(2)} end`); }, banks: [bank('bank-a')] });
    expect(rows[1].detail).toContain('0x<redacted>');
    noKey(rows[1].detail);
    const long = await compareViewKeys({ registry: async () => { throw new Error('x'.repeat(500)); }, banks: [bank('bank-a')] });
    expect(long[1].detail.length).toBeLessThanOrEqual(80);
  });
  it('a non-Error throw (string, undefined) still yields a registry_error row', async () => {
    const rows = await compareViewKeys({ registry: async () => { throw 'boom'; }, banks: [bank('bank-a')] });
    expect(rows[1]).toMatchObject({ status: 'registry_error', detail: 'boom' });
  });
});

describe('formatRow', () => {
  it('one exact line per row', () => {
    expect(formatRow({ bank: 'bank-a', status: 'OK', detail: '' })).toBe('OK bank-a');
    expect(formatRow({ bank: 'bank-b', status: 'MISMATCH', detail: 'registry differs' })).toBe('MISMATCH bank-b registry differs');
    expect(formatRow({ bank: 'bank-a', status: 'registry_error', detail: 'ECONNREFUSED' })).toBe('registry_error bank-a ECONNREFUSED');
    expect(formatRow({ bank: 'bank-c', status: 'unregistered', detail: '' })).toBe('unregistered bank-c');
    expect(formatRow({ bank: 'bank-c', status: 'missing_copy', detail: '' })).toBe('missing_copy bank-c');
    expect(formatRow({ bank: 'bank-d', status: 'ignored', detail: '' })).toBe('ignored bank-d');
  });
  it('no key hex in any row, detail, formatted line or summary, whatever the outcome', async () => {
    const cases = [
      reg(registered), reg({ ...registered, [idOf('bank-b')]: A.metaAddress }), reg({}), reg({ ...registered, [idOf('bank-a')]: '0x1234' }),
      async () => { throw new Error(`k=${A.spendKey} ${B.viewKey}`); },
    ];
    for (const registry of cases) {
      for (const bs of [banks, [{ ...bank('bank-a'), viewKey: B.viewKey }], []]) {
        const rows = await compareViewKeys({ registry, banks: bs });
        for (const r of rows) { noKey(JSON.stringify(r)); noKey(formatRow(r)); }
        noKey(summaryLine(rows));
      }
    }
  });
});

describe('exitCode', () => {
  const four = (s: CompareRow['status'][]) => PARTIES.map((bank, i): CompareRow => ({ bank, status: s[i], detail: '' }));
  it('0 only when every one of the four parties is OK', () => {
    expect(exitCode(four(['OK', 'OK', 'OK', 'OK']))).toBe(0);
    expect(exitCode([])).toBe(1);
    expect(exitCode(four(['OK', 'OK', 'OK', 'OK']).slice(0, 3))).toBe(1); // a party with no row
    for (const s of ['MISMATCH', 'unregistered', 'bad_copy', 'registry_error', 'missing_copy', 'ignored'] as const) {
      for (let i = 0; i < 4; i++) { const st = ['OK', 'OK', 'OK', 'OK'] as CompareRow['status'][]; st[i] = s; expect(exitCode(four(st))).toBe(1); }
    }
  });
});

describe('readOnlySend (the compare process may only READ the node)', () => {
  it('allows eth_call, eth_blockNumber, eth_chainId and passes the answer through', async () => {
    const inner = vi.fn(async (m: string) => `ans:${m}`);
    const send = readOnlySend(inner);
    for (const m of ['eth_call', 'eth_blockNumber', 'eth_chainId']) expect(await send(m, [])).toBe(`ans:${m}`);
    expect(inner).toHaveBeenCalledTimes(3);
  });
  it('rejects anything else with `rpc method not allowed: <name>` BEFORE the inner send is reached', async () => {
    const inner = vi.fn(async () => 'x');
    const send = readOnlySend(inner);
    for (const m of ['eth_sendRawTransaction', 'eth_getLogs', 'eth_sendTransaction', 'personal_sign', 'debug_traceTransaction']) {
      await expect(send(m, [])).rejects.toThrow(`rpc method not allowed: ${m}`);
    }
    expect(inner).not.toHaveBeenCalled();
  });
  it('guardProvider: a real ethers provider cannot broadcast or read logs through it (rejected locally, nothing is sent)', async () => {
    const p = guardProvider(createProvider('http://127.0.0.1:1', 1337n)); // port 1: any request that left the process would fail with a connection error instead
    await expect(p.broadcastTransaction('0x02')).rejects.toThrow(/rpc method not allowed: eth_sendRawTransaction/);
    await expect(p.getLogs({ address: '0x' + '11'.repeat(20), fromBlock: 0, toBlock: 1 })).rejects.toThrow(/rpc method not allowed: eth_getLogs/);
    expect(p).toBeInstanceOf(JsonRpcProvider);
  });
});

describe('loadViewCopiesWithIdentity', () => {
  const idA = idOf('bank-a');
  const idB = idOf('bank-b');
  const files: Record<string, string> = {
    '/v/bank-a.viewKey': '0xV1\n', '/v/bank-a.metaAddress': '0xM1\n', '/v/bank-a.identityAddress': idA + '\n',
    '/v/bank-b.viewKey': '0xV2', '/v/bank-b.metaAddress': '0xM2', '/v/bank-b.identityAddress': idB,
  };
  const read = (p: string) => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; };
  const list = () => ['bank-b.identityAddress', 'bank-b.metaAddress', 'bank-b.viewKey', 'bank-a.viewKey', 'bank-a.metaAddress', 'bank-a.identityAddress', '..data'];
  it('one holder per <id>.viewKey, sorted by id, files trimmed', () => {
    expect(loadViewCopiesWithIdentity('/v', read, list)).toEqual([
      { id: 'bank-a', viewKey: '0xV1', metaAddress: '0xM1', identityAddress: idA },
      { id: 'bank-b', viewKey: '0xV2', metaAddress: '0xM2', identityAddress: idB },
    ]);
  });
  it('absent directory (ENOENT) -> empty; any other listing error stays fatal', () => {
    const enoent = () => { throw Object.assign(new Error('no dir'), { code: 'ENOENT' }); };
    expect(loadViewCopiesWithIdentity('/nowhere', read, enoent)).toEqual([]);
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(() => loadViewCopiesWithIdentity('/v', read, eacces)).toThrow(/denied/);
  });
  it('missing identityAddress file -> error naming it; missing metaAddress file too', () => {
    const noId = (p: string) => (p.endsWith('bank-b.identityAddress') ? read('/missing') : read(p));
    expect(() => loadViewCopiesWithIdentity('/v', noId, list)).toThrow(/bank-b\.identityAddress/);
    const noMeta = (p: string) => (p.endsWith('bank-a.metaAddress') ? read('/missing') : read(p));
    expect(() => loadViewCopiesWithIdentity('/v', noMeta, list)).toThrow(/bank-a\.metaAddress/);
  });
  it('an identityAddress that is not an address -> error naming the file (and not its content)', () => {
    const bad = (p: string) => (p.endsWith('bank-a.identityAddress') ? 'not-an-address-' + A.spendKey : read(p));
    let msg = '';
    try { loadViewCopiesWithIdentity('/v', bad, list); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/bank-a\.identityAddress/);
    expect(msg).not.toContain(A.spendKey.slice(2));
  });
});
