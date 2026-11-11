// RED tests for the analyst verdict on /cert (items 1, 7, 8): role custodian signs only what the rules allow, never trusts request fields for nonce/domain.
import { Interface, Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CERTIFICATE_LENGTH, payloadWithoutCertificate, signCertificate } from '../../ts/bond.ts';
import { TRANCHE_A } from '../../ts/chain.ts';
import { BOND, FakeChain, NOW, start } from './fixtures.ts';

const bondAbi = new Interface([
  'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo, bytes data)',
  'function transferByPartition(bytes32 partition, address to, uint256 value, bytes data)',
  'function mint(address to, uint256 value)',
]);
const certKey = Wallet.createRandom().privateKey;
const BANK = { subject: 'CN=bank-signer-A' };
const cfg = { role: 'custodian' as const, bankSigners: ['CN=bank-signer-A'] };
const sender = Wallet.createRandom().address;
const receiver = Wallet.createRandom().address;
const ph = new Uint8Array(CERTIFICATE_LENGTH);

const stealthPayload = () => payloadWithoutCertificate(bondAbi.encodeFunctionData('transferByPartitionStealth', [TRANCHE_A, receiver, 100n, '0x02' + '11'.repeat(32), '0x01', '0x', ph]));
const plainPayload = (to: string) => payloadWithoutCertificate(bondAbi.encodeFunctionData('transferByPartition', [TRANCHE_A, to, 100n, ph]));
const req = (over: Record<string, unknown> = {}) => ({ sender, token: BOND, payload: stealthPayload(), expiry: String(NOW + 600n), ...over });

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
async function custodian(chain: FakeChain, peer: { subject: string } | undefined = BANK) {
  const s = await start(chain, { cfg, keys: { certKey }, peer: () => peer }); stop = s.stop; return s;
}

describe('/cert on role custodian', () => {
  it('role bank -> 403 role_forbidden', async () => {
    const chain = new FakeChain();
    const s = await start(chain); stop = s.stop;
    const r = await s.call('POST', '/cert', req());
    expect([r.status, r.json.error]).toEqual([403, 'role_forbidden']);
  });

  it('signs with nonce and domain separator read from the chain, ignoring fields in the request', async () => {
    const chain = new FakeChain(); chain.certNonces.set((BOND + sender).toLowerCase(), 7n);
    const s = await custodian(chain);
    const body = req({ nonce: '999', domainSeparator: '0x' + 'ee'.repeat(32) });
    const r = await s.call('POST', '/cert', body);
    expect(r.status).toBe(200);
    const expected = signCertificate(certKey, { domainSeparator: chain.domain, msgSender: sender, token: BOND, payload: body.payload, expiry: NOW + 600n, nonce: 7n });
    expect(r.json.certificate).toBe(expected);
  });

  it('(a) client cert not a registered bank signer (or none) -> 403 and nothing signed', async () => {
    const chain = new FakeChain();
    for (const peer of [{ subject: 'CN=stranger' }, undefined]) {
      const s = await custodian(chain, peer);
      const r = await s.call('POST', '/cert', req());
      expect([r.status, r.json.error]).toEqual([403, 'not_registered_signer']);
      await stop?.(); stop = undefined;
    }
  });

  it('(a) logs requester, sender, token and selector', async () => {
    const chain = new FakeChain();
    const s = await custodian(chain);
    await s.call('POST', '/cert', req());
    const line = s.rec.logs.join('\n').toLowerCase();
    expect(line).toContain('cn=bank-signer-a');
    expect(line).toContain(sender.toLowerCase());
    expect(line).toContain(BOND.toLowerCase());
    expect(line).toContain(bondAbi.getFunction('transferByPartitionStealth')!.selector.toLowerCase());
  });

  it('(b) token must equal the bond -> 422 bad_token', async () => {
    const s = await custodian(new FakeChain());
    const r = await s.call('POST', '/cert', req({ token: Wallet.createRandom().address }));
    expect([r.status, r.json.error]).toEqual([422, 'bad_token']);
  });

  it('(c) expiry must be <= chain now + 600 -> 422 bad_expiry', async () => {
    const s = await custodian(new FakeChain());
    expect((await s.call('POST', '/cert', req({ expiry: String(NOW + 600n) }))).status).toBe(200);
    const r = await s.call('POST', '/cert', req({ expiry: String(NOW + 601n) }));
    expect([r.status, r.json.error]).toEqual([422, 'bad_expiry']);
  });

  it('(d) selector allowlist: transferByPartitionStealth ok; transferByPartition only to an escrow of OUR DvPFactory; anything else rejected', async () => {
    const chain = new FakeChain(); const escrow = Wallet.createRandom().address; chain.escrows.add(escrow.toLowerCase());
    const s = await custodian(chain);
    expect((await s.call('POST', '/cert', req({ payload: plainPayload(escrow) }))).status).toBe(200);
    const notEscrow = await s.call('POST', '/cert', req({ payload: plainPayload(Wallet.createRandom().address) }));
    expect([notEscrow.status, notEscrow.json.error]).toEqual([422, 'selector_not_allowed']);
    const mint = payloadWithoutCertificate(bondAbi.encodeFunctionData('mint', [receiver, 1n]) + '00'.repeat(CERTIFICATE_LENGTH + 63));
    const other = await s.call('POST', '/cert', req({ payload: mint }));
    expect([other.status, other.json.error]).toEqual([422, 'selector_not_allowed']);
  });

  it('never returns or logs the cert key', async () => {
    const s = await custodian(new FakeChain());
    await s.call('POST', '/cert', req()); await s.call('POST', '/cert', req({ token: sender }));
    const hay = [...s.rec.bodies, ...s.rec.logs].join('\n').toLowerCase();
    expect(hay).not.toContain(certKey.toLowerCase()); expect(hay).not.toContain(certKey.slice(2).toLowerCase());
  });
});
