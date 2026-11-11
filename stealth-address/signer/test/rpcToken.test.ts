// Per-request RPC JWT minter (Besu use-besu-api/authenticate: RS256, payload `permissions` + `exp`). Fixture key generated here, no file on disk.
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpcTokenSource, mintScopedToken } from '../src/rpcToken.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const dec = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());

describe('createRpcTokenSource', () => {
  it('mints RS256 with eth|net|web3 permissions and exp <= now+900, verifiable with the public key', () => {
    let now = 1_800_000_000;
    const token = createRpcTokenSource(privateKey, () => now)();
    const [h, p, s] = token.split('.');
    expect(dec(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const pl = dec(p);
    expect(pl.permissions).toEqual(['eth:*', 'net:*', 'web3:*']);
    expect(pl.iat).toBe(now);
    expect(pl.exp).toBeLessThanOrEqual(now + 900);
    expect(pl.exp).toBeGreaterThan(now);
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('reuses a token while it has more than 60 s left, mints a new one after', () => {
    let now = 1_800_000_000;
    const next = createRpcTokenSource(privateKey, () => now);
    const a = next();
    now += 800; // 100 s left
    expect(next()).toBe(a);
    now += 50; // 50 s left
    const b = next();
    expect(b).not.toBe(a);
    expect(dec(b.split('.')[1]).exp).toBeLessThanOrEqual(now + 900);
  });

  it('a bad key fails without echoing key material', () => {
    const bad = privateKey.replace(/\n[^\n-]{20,}\n/, '\nnot-a-key-body\n');
    let msg = '';
    try { createRpcTokenSource(bad, () => 1)(); } catch (e) { msg = String((e as Error).message); }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('not-a-key-body');
    expect(msg).not.toContain(privateKey.split('\n')[1]);
  });
});

describe('createProvider with a token source', () => {
  it('sends a fresh Authorization header on every request', async () => {
    const { createServer } = await import('node:http');
    const { createProvider } = await import('../src/chainPort.ts');
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(String(req.headers.authorization));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const q = JSON.parse(body);
        const one = (m: { id: number }) => ({ jsonrpc: '2.0', id: m.id, result: '0x1' });
        res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    let n = 0;
    const provider = createProvider(`http://127.0.0.1:${(srv.address() as { port: number }).port}`, 1n, () => `tok${++n}`);
    await provider.send('eth_blockNumber', []);
    await provider.send('eth_blockNumber', []);
    srv.close();
    expect(seen).toEqual(['Bearer tok1', 'Bearer tok2']);
  });
});

// S11 compare job: a token scoped to three read methods, minted by the operator from the node's key, NOT the key itself in the pod.
const READ = ['eth:call', 'eth:blockNumber', 'eth:chainId'];
const verifies = (token: string) => { const [h, p, sig] = token.split('.'); return createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey(publicKey), Buffer.from(sig, 'base64url')); };

describe('mintScopedToken', () => {
  it('RS256, permissions EXACTLY the list passed, exp = now + ttl, verifies with the public key, no extra claims', () => {
    const now = 1_800_000_000;
    const token = mintScopedToken(privateKey, READ, 30 * 86400, () => now);
    const [h, p] = token.split('.');
    expect(dec(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const pl = dec(p);
    expect(pl.permissions).toEqual(['eth:call', 'eth:blockNumber', 'eth:chainId']);
    expect(pl.exp).toBe(now + 30 * 86400);
    expect(pl.iat).toBe(now);
    expect(Object.keys(pl).sort()).toEqual(['exp', 'iat', 'permissions']);
    expect(JSON.stringify(pl)).not.toMatch(/\*|net:|web3:/);
    expect(verifies(token)).toBe(true);
  });
  it('another list is passed through as is (nothing is added)', () => {
    expect(dec(mintScopedToken(privateKey, ['eth:call'], 60, () => 1).split('.')[1]).permissions).toEqual(['eth:call']);
  });
  it('a bad key fails without echoing key material', () => {
    const bad = privateKey.replace(/\n[^\n-]{20,}\n/, '\nnot-a-key-body\n');
    let msg = '';
    try { mintScopedToken(bad, READ, 60, () => 1); } catch (e) { msg = String((e as Error).message); }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('not-a-key-body');
  });
});

describe('mintCompareToken CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-'));
  const pem = join(dir, 'private.pem');
  writeFileSync(pem, privateKey, { mode: 0o600 });
  const cli = join(__dirname, '../src/mintCompareToken.ts');
  const run = (...a: string[]) => spawnSync('node', ['--experimental-transform-types', cli, ...a], { encoding: 'utf8' });
  it('writes the token (0600), prints only `wrote <out> exp=<UTC> permissions=<list>`, default 30 days', () => {
    const out = join(dir, 'tok');
    const r = run(pem, out);
    expect(r.status).toBe(0);
    const token = readFileSync(out, 'utf8').trim();
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(r.stdout).toMatch(new RegExp(`^wrote ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} exp=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z permissions=eth:call,eth:blockNumber,eth:chainId\n$`));
    expect(r.stdout + r.stderr).not.toContain(token);
    expect(r.stdout + r.stderr).not.toContain(privateKey.split('\n')[1]);
    const pl = dec(token.split('.')[1]);
    expect(pl.permissions).toEqual(READ);
    expect(Math.abs(pl.exp - (Date.now() / 1000 + 30 * 86400))).toBeLessThan(60);
    expect(verifies(token)).toBe(true);
  });
  it('an explicit number of days sets the expiry', () => {
    const out = join(dir, 'tok7');
    expect(run(pem, out, '7').status).toBe(0);
    expect(Math.abs(dec(readFileSync(out, 'utf8').trim().split('.')[1]).exp - (Date.now() / 1000 + 7 * 86400))).toBeLessThan(60);
  });
  it('bad usage or a bad key: non-zero exit, no token file, nothing secret printed', () => {
    const none = join(dir, 'none');
    for (const a of [[], [pem], [pem, none, '0'], [pem, none, 'x'], [join(dir, 'nokey.pem'), none]]) {
      const r = run(...a);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
    }
    const junk = join(dir, 'junk.pem');
    writeFileSync(junk, 'not-a-key-body');
    const r = run(junk, none);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain('not-a-key-body');
    expect(() => statSync(none)).toThrow();
  });
});
