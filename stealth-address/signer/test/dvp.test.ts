// S17 DvP + award without keys in Lensa (2026-11-13, user "kerjakan S17"): Lensa only orchestrates. Each side's own signer picks the funding
// holding and builds the leg it pays to the counterparty (/dvp/offer, /dvp/bid); the custodian signs the escrow's settle + refund certificates for
// the CREATE2 address it computes itself (/escrow-certs, BI signer only); the BI signer (issuer key = DvPFactory.custodian) creates the escrow
// (/dvp/escrow); each side funds its leg from the holding it offered (dvp-leg `source`); anyone settles (/dvp/settle, throwaway key).
import { Interface, Signature, Wallet, getBytes, hexlify, recoverAddress } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBondMetadata, certificateDigest, payloadWithoutCertificate } from '../../ts/bond.ts';
import { TRANCHE_A } from '../../ts/chain.ts';
import { scan } from '../../ts/stealth.ts';
import { buildTokenMetadata } from '../../ts/token.ts';
import { A, B, BOND, NOW, RD, FakeChain, decodeRaw, fund, start } from './fixtures.ts';

const FACTORY = '0x00000000000000000000000000000000000000f1';
const ESCROW = '0x00000000000000000000000000000000000000e5';
const ISSUER = '0x' + '99'.repeat(32), BI_SPEND = '0x' + '31'.repeat(32), BI_VIEW = '0x' + '32'.repeat(32), CERT_KEY = '0x' + '55'.repeat(32);
const biKeys = { issuerKey: ISSUER, spendKey: BI_SPEND, viewKey: BI_VIEW, viewCopies: [] };
const TRADE = '0x' + '0a'.repeat(32);
const settleAbi = new Interface(['function settle()']);
const factoryAbi = new Interface([
  'function create((bytes32 tradeId, address bond, bytes32 partition, uint256 bondAmount, address rd, uint256 rdAmount, address seller, address buyer, uint256 expiry, uint256 refundWindow, (address receiver, bytes ephemeralPubKey, bytes1 viewTag, bytes memo) bondLeg, (address receiver, bytes ephemeralPubKey, bytes1 viewTag, bytes memo) rdLeg) t, bytes settleCert, bytes refundCert)',
]);
const bondAbi = new Interface([
  'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo, bytes data)',
  'function transferByPartition(bytes32 partition, address to, uint256 value, bytes data)',
]);
const ZERO_CERT = hexlify(new Uint8Array(97));

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
const run = async (chain: FakeChain, opts: Parameters<typeof start>[1] = {}) => { const s = await start(chain, opts); stop = s.stop; return s; };
const leg = (l: any) => ({ receiver: l.receiver, ephemeralPubKey: l.ephemeralPubKey, viewTag: l.viewTag, memo: l.memo });
// The receiver finds a leg with its own keys, exactly as it would after the escrow announces it.
const finds = (l: any, keys: { viewKey: string; spendKey: string }, metadata: string) =>
  scan([{ schemeId: 1n, stealthAddress: l.receiver, ephemeralPubKey: l.ephemeralPubKey, metadata }], keys.viewKey, keys.spendKey).length === 1;

describe('POST /dvp/offer (seller side, bank or BI)', () => {
  it('picks the bond holding that covers the amount and returns it with the bond leg to the buyer (buyer can scan it)', async () => {
    const chain = new FakeChain();
    const src = fund(chain, 'bond', 5n);
    const { call } = await run(chain);
    const r = await call('POST', '/dvp/offer', { tradeId: TRADE, amount: '1', buyerMeta: B.metaAddress });
    expect(r.status).toBe(200);
    expect(r.json.seller).toBe(src);
    const l = r.json.bondLeg;
    expect(finds(l, B, buildBondMetadata(l.viewTag, BOND, 1n, TRANCHE_A, l.memo))).toBe(true);
    expect(chain.sent).toEqual([]); // nothing signed or sent yet
  });
  it('no single holding covers -> 422 insufficient_holdings; bad buyer meta -> 422 bad_meta_address', async () => {
    const chain = new FakeChain();
    fund(chain, 'bond', 1n);
    const { call } = await run(chain);
    expect((await call('POST', '/dvp/offer', { tradeId: TRADE, amount: '2', buyerMeta: B.metaAddress })).json.error).toBe('insufficient_holdings');
    expect((await call('POST', '/dvp/offer', { tradeId: TRADE, amount: '1', buyerMeta: '0x1234' })).json.error).toBe('bad_meta_address');
  });
});

describe('POST /dvp/bid (buyer side)', () => {
  it('picks the RD holding that covers the price and returns it with the RD leg to the seller (seller can scan it)', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 10n);
    const src = fund(chain, 'rd', 2_000_000n, 2);
    const { call } = await run(chain);
    const r = await call('POST', '/dvp/bid', { tradeId: TRADE, price: '1000000', sellerMeta: B.metaAddress });
    expect(r.status).toBe(200);
    expect(r.json.buyer).toBe(src);
    const l = r.json.rdLeg;
    expect(finds(l, B, buildTokenMetadata(l.viewTag, RD, 1_000_000n, l.memo))).toBe(true);
  });
});

describe('POST /intent dvp-leg with source', () => {
  it('funds the escrow from the holding named in `source` (the one offered), not the first covering one', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 5_000_000n);
    const src = fund(chain, 'rd', 1_000_000n, 2);
    const { call } = await run(chain);
    const r = await call('POST', '/intent', { kind: 'dvp-leg', leg: 'rd', from: 'A', amount: '1000000', escrow: ESCROW, source: src });
    expect(r.status).toBe(200);
    expect(decodeRaw(chain.sent[0]!).from).toBe(src);
  });
  it('a source that is not ours or does not cover -> 422 insufficient_holdings, nothing sent', async () => {
    const chain = new FakeChain();
    fund(chain, 'rd', 5n);
    const { call } = await run(chain);
    const r = await call('POST', '/intent', { kind: 'dvp-leg', leg: 'rd', from: 'A', amount: '5', escrow: ESCROW, source: ESCROW });
    expect(r.json.error).toBe('insufficient_holdings');
    expect(chain.sent).toEqual([]);
  });
});

const termsBody = (bondLeg: any, rdLeg: any) => ({ tradeId: TRADE, seller: A.identityKey.slice(0, 42), buyer: '0x' + '0b'.repeat(20), bondAmount: '1', rdAmount: '1000000', bondLeg, rdLeg });
const someLeg = { receiver: '0x' + '0c'.repeat(20), ephemeralPubKey: '0x02' + '11'.repeat(32), viewTag: '0x7f', memo: '0x' + 'ab'.repeat(20) };

describe('POST /dvp/escrow (BI signer: issuer key = DvPFactory.custodian)', () => {
  it('fixes expiry (now + ttl) and refundWindow, gets both certs from the custodian, signs DvPFactory.create with the issuer key', async () => {
    const chain = new FakeChain();
    chain.predicted = ESCROW;
    const asked: any[] = [];
    const cert = { request: vi.fn(), escrowCerts: vi.fn(async (t: any) => { asked.push(t); return { settleCert: '0x' + 'aa'.repeat(97), refundCert: '0x' + 'bb'.repeat(97) }; }) };
    const { call } = await run(chain, { cfg: { role: 'bi', party: 'BI', dvpFactory: FACTORY }, keys: biKeys as any, cert: cert as any });
    const body = { ...termsBody(someLeg, someLeg), seller: '0x' + '0d'.repeat(20) };
    const r = await call('POST', '/dvp/escrow', body);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ escrow: ESCROW, expiry: String(NOW + 600n) });
    const tx = decodeRaw(chain.sent[0]!);
    expect(tx.from).toBe(new Wallet(ISSUER).address);
    expect(tx.to?.toLowerCase()).toBe(FACTORY);
    const [t, s, f] = factoryAbi.decodeFunctionData('create', tx.data);
    expect([t.bond, t.rd, t.partition, t.expiry, t.refundWindow, t.bondAmount, t.rdAmount]).toEqual([
      expect.stringMatching(new RegExp(BOND.slice(2), 'i')), expect.stringMatching(new RegExp(RD.slice(2), 'i')), TRANCHE_A, NOW + 600n, 600n, 1n, 1_000_000n]);
    expect([s, f]).toEqual(['0x' + 'aa'.repeat(97), '0x' + 'bb'.repeat(97)]);
    expect(asked[0].expiry).toBe((NOW + 600n).toString());
  });
  it('a bank signer cannot create escrows -> 403 role_forbidden', async () => {
    const { call } = await run(new FakeChain());
    expect((await call('POST', '/dvp/escrow', termsBody(someLeg, someLeg))).json.error).toBe('role_forbidden');
  });
});

describe('POST /escrow-certs (custodian, caller = the BI signer only)', () => {
  const custodian = (chain: FakeChain, subject = 'CN=bi-signer') =>
    run(chain, { cfg: { role: 'custodian', party: 'BI', biSigner: 'CN=bi-signer' }, keys: { certKey: CERT_KEY } as any, peer: () => ({ subject }) });
  const terms = (over: Record<string, unknown> = {}) => ({
    tradeId: TRADE, bond: BOND, partition: TRANCHE_A, bondAmount: '1', rd: RD, rdAmount: '1000000', seller: '0x' + '0d'.repeat(20), buyer: '0x' + '0b'.repeat(20),
    expiry: String(NOW + 600n), refundWindow: '600', bondLeg: someLeg, rdLeg: someLeg, ...over,
  });
  it('computes the escrow address itself and signs settle (stealth leg to the buyer) + refund (back to the seller) for it', async () => {
    const chain = new FakeChain();
    chain.predicted = ESCROW;
    const { call } = await custodian(chain);
    const r = await call('POST', '/escrow-certs', terms());
    expect(r.status).toBe(200);
    expect(r.json.escrow).toBe(ESCROW);
    const check = (certHex: string, fn: string, args: unknown[], expiry: bigint) => {
      const c = getBytes(certHex);
      expect(c.length).toBe(97);
      expect(BigInt(hexlify(c.slice(0, 32)))).toBe(expiry);
      const payload = payloadWithoutCertificate(bondAbi.encodeFunctionData(fn, [...args, ZERO_CERT]));
      const digest = certificateDigest({ domainSeparator: chain.domain, msgSender: ESCROW, token: BOND, payload, expiry, nonce: 0n });
      const sig = Signature.from({ r: hexlify(c.slice(32, 64)), s: hexlify(c.slice(64, 96)), v: c[96]! });
      expect(recoverAddress(digest, sig)).toBe(new Wallet(CERT_KEY).address);
    };
    check(r.json.settleCert, 'transferByPartitionStealth', [TRANCHE_A, someLeg.receiver, 1n, someLeg.ephemeralPubKey, someLeg.viewTag, someLeg.memo], NOW + 600n);
    check(r.json.refundCert, 'transferByPartition', [TRANCHE_A, '0x' + '0d'.repeat(20), 1n], NOW + 1200n);
  });
  it('refuses: caller not the BI signer 403; other token 422 bad_token; expiry too far 422 bad_expiry; refundWindow != ttl 422 bad_request', async () => {
    const chain = new FakeChain();
    chain.predicted = ESCROW;
    expect((await (await custodian(chain, 'CN=bank-a-signer')).call('POST', '/escrow-certs', terms())).json.error).toBe('not_bi_signer');
    await stop?.(); stop = undefined;
    const { call } = await custodian(chain);
    expect((await call('POST', '/escrow-certs', terms({ bond: RD }))).json.error).toBe('bad_token');
    expect((await call('POST', '/escrow-certs', terms({ expiry: String(NOW + 601n) }))).json.error).toBe('bad_expiry');
    expect((await call('POST', '/escrow-certs', terms({ refundWindow: '6000' }))).json.error).toBe('bad_request');
  });
});

describe('POST /dvp/settle', () => {
  it('sends escrow.settle() from a throwaway key (anyone may settle; no party key signs it)', async () => {
    const chain = new FakeChain();
    const { call } = await run(chain);
    const r = await call('POST', '/dvp/settle', { escrow: ESCROW });
    expect(r.status).toBe(200);
    const tx = decodeRaw(chain.sent[0]!);
    expect(tx.to?.toLowerCase()).toBe(ESCROW);
    expect(tx.data).toBe(settleAbi.encodeFunctionData('settle'));
    expect([new Wallet(A.identityKey).address]).not.toContain(tx.from);
    expect(r.json.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

