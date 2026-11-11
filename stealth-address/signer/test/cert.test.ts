// RED tests for PLAN S8 proof (5): the bank-side cert-request client against a stub /cert server.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Interface, Wallet, getBytes, hexlify } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANCHE_A } from '../../ts/chain.ts';
import { CERTIFICATE_LENGTH, payloadWithoutCertificate, signCertificate } from '../../ts/bond.ts';
import { createCertClient } from '../src/certClient.ts';
import { B, BOND, FakeChain, NOW, decodeRaw, fund, start } from './fixtures.ts';

const bondAbi = new Interface([
  'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo, bytes data)',
]);

// Stub custodian: records the request body, answers with a real 97-byte certificate signed by a throwaway key.
async function stubCert() {
  const seen: any[] = [];
  const certificate = signCertificate(Wallet.createRandom().privateKey, {
    domainSeparator: '0x' + 'aa'.repeat(32), msgSender: Wallet.createRandom().address, token: BOND, payload: '0x1234', expiry: NOW + 600n, nonce: 0n,
  });
  const server: Server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ certificate }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, certificate, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; vi.restoreAllMocks(); });

describe('(5) cert-request client', () => {
  it('POST /cert carries sender, payload, expiry and returns the certificate', async () => {
    const stub = await stubCert(); cleanup.push(stub.close);
    const client = createCertClient({ url: stub.url });
    const sender = Wallet.createRandom().address;
    const got = await client.request({ sender, token: BOND, payload: '0xdeadbeef', expiry: NOW + 600n });
    expect(got).toBe(stub.certificate);
    expect(getBytes(got)).toHaveLength(CERTIFICATE_LENGTH);
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]).toMatchObject({ method: 'POST', url: '/cert', body: { sender, payload: '0xdeadbeef', expiry: String(NOW + 600n) } });
  });

  it('bond-transfer intent: signer asks the custodian, attaches the returned cert as the last argument', async () => {
    const stub = await stubCert(); cleanup.push(stub.close);
    const chain = new FakeChain();
    const held = fund(chain, 'bond', 300n);
    const s = await start(chain, { cert: createCertClient({ url: stub.url }) }); cleanup.push(s.stop);
    const r = await s.call('POST', '/intent', { kind: 'bond-transfer', from: 'A', to: { metaAddress: B.metaAddress }, amount: '100' });
    expect(r.status).toBe(200);
    const tx = decodeRaw(r.json.rawTx);
    expect(tx.from).toBe(held);
    expect(tx.to?.toLowerCase()).toBe(BOND.toLowerCase());
    const args = bondAbi.decodeFunctionData('transferByPartitionStealth', tx.data);
    expect(args[0]).toBe(TRANCHE_A);
    expect(args[6]).toBe(stub.certificate); // returned cert attached
    // The request described exactly this call (payload = calldata minus the certificate tail) from this sender.
    const placeholder = bondAbi.encodeFunctionData('transferByPartitionStealth', [...args.slice(0, 6), new Uint8Array(CERTIFICATE_LENGTH)]);
    expect(stub.seen).toHaveLength(1);
    const body = stub.seen[0].body;
    expect(body.sender.toLowerCase()).toBe(held.toLowerCase());
    expect(body.payload).toBe(payloadWithoutCertificate(placeholder));
    expect(BigInt(body.expiry)).toBe(NOW + 600n); // chainNow + 600 (ts/chain.ts:82)
    expect(hexlify(getBytes(body.payload))).toBe(body.payload);
  });
});
