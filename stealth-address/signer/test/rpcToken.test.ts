// Per-request RPC JWT minter (Besu use-besu-api/authenticate: RS256, payload `permissions` + `exp`). Fixture key generated here, no file on disk.
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRpcTokenSource } from '../src/rpcToken.ts';

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
