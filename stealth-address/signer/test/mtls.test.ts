// RED test for verdict 6: mTLS client via node:https (no undici) behind the injectable fetch port.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMtlsFetch } from '../src/mtls.ts';

function pki(srvSan = 'subjectAltName=DNS:localhost,IP:127.0.0.1') {
  const d = mkdtempSync(join(tmpdir(), 'mtls-'));
  const sh = (...a: string[]) => execFileSync('openssl', a, { cwd: d, stdio: 'pipe' });
  sh('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=test-ca', '-days', '2');
  for (const [n, cn, san] of [['srv', 'localhost', srvSan], ['cli', 'bank-signer-A', 'subjectAltName=DNS:bank-signer-A']] as const) {
    sh('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', `/CN=${cn}`);
    execFileSync('sh', ['-c', `printf '${san}\\n' > ${n}.ext && openssl x509 -req -in ${n}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ${n}.crt -days 2 -extfile ${n}.ext`], { cwd: d, stdio: 'pipe' });
  }
  const f = (n: string) => readFileSync(join(d, n), 'utf8');
  return { ca: f('ca.crt'), srvKey: f('srv.key'), srvCrt: f('srv.crt'), cliKey: f('cli.key'), cliCrt: f('cli.crt') };
}

describe('createMtlsFetch (node:https, client cert)', () => {
  it('presents the client cert (server requires it) and verifies the server against ca; no client cert -> fails', async () => {
    const k = pki();
    const seen: string[] = [];
    const server = createServer({ key: k.srvKey, cert: k.srvCrt, ca: k.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      seen.push(String((req.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN));
      res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `https://localhost:${(server.address() as AddressInfo).port}/x`;
    try {
      const f = createMtlsFetch({ key: k.cliKey, cert: k.cliCrt, ca: k.ca });
      const res = await f(url, { method: 'POST', body: '{}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(seen).toEqual(['bank-signer-A']);
      const noCert = createMtlsFetch({ key: '', cert: '', ca: k.ca });
      await expect(noCert(url)).rejects.toThrow();
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  it('servername sets the SNI and the identity the server cert is verified against (gateway passthrough: dial an IP or gateway host, name the custodian)', async () => {
    const k = pki('subjectAltName=DNS:custodian-1');
    let sni = '';
    const server = createServer({ key: k.srvKey, cert: k.srvCrt, ca: k.ca, requestCert: true, rejectUnauthorized: true }, (_req, res) => res.end('ok'));
    server.on('tlsClientError', () => {});
    server.on('secureConnection', (s) => { sni = (s as import('node:tls').TLSSocket).servername || ''; });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
    try {
      await expect(createMtlsFetch({ key: k.cliKey, cert: k.cliCrt, ca: k.ca })(url)).rejects.toThrow();
      const res = await createMtlsFetch({ key: k.cliKey, cert: k.cliCrt, ca: k.ca, servername: 'custodian-1' })(url);
      expect(res.status).toBe(200);
      expect(sni).toBe('custodian-1');
    } finally { server.close(); }
  });
});
