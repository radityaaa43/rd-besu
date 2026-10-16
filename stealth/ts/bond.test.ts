import { Interface, SigningKey, computeAddress, getBytes, hexlify, recoverAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_LENGTH,
  buildBondMetadata,
  certificateDigest,
  parseBondMetadata,
  payloadWithoutCertificate,
  signCertificate,
} from './bond.ts';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from './stealth.ts';

const TOKEN = '0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9';
const TRANCHE_A = '0x5452414e4348452d410000000000000000000000000000000000000000000000'; // bytes32("TRANCHE-A")
const GOLDEN =
  '0x20f3d490dbd8606ed2ecdb71fdcb8cca8fa1925ff84238f2a900000000000000000000000000000000000000000000000000000000000003e85452414e4348452d410000000000000000000000000000000000000000000000';

describe('buildBondMetadata', () => {
  it('matches the golden 89-byte vector', () => {
    expect(buildBondMetadata('0x20', TOKEN, 1000n, TRANCHE_A)).toBe(GOLDEN);
    expect((GOLDEN.length - 2) / 2).toBe(89);
  });

  it('throws on bad input', () => {
    expect(() => buildBondMetadata('0x2000', TOKEN, 1n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', '0x1234', 1n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', TOKEN, -1n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', TOKEN, 2n ** 256n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', TOKEN, 1n, '0x5452')).toThrow();
  });
});

describe('parseBondMetadata', () => {
  it('round-trips and parses the golden vector', () => {
    expect(parseBondMetadata(GOLDEN)).toEqual({ viewTag: '0x20', token: TOKEN, amount: 1000n, partition: TRANCHE_A });
    expect(parseBondMetadata(buildBondMetadata('0x7f', TOKEN, 123456789n, TRANCHE_A))?.amount).toBe(123456789n);
  });

  // Never throws, always null for anything that is not the 89-byte form.
  it('returns null for anything else', () => {
    const body = GOLDEN.slice(2);
    const rd57 = '0x20a9059cbbd8606ed2ecdb71fdcb8cca8fa1925ff84238f2a900000000000000000000000000000000000000000000000000000000000003e8';
    for (const bad of [
      '0x',
      '0x20',
      rd57, // RD token metadata
      '0x' + body.slice(0, 88 * 2),
      GOLDEN + '00',
      '0x20' + 'deadbeef' + body.slice(10),
      'not hex',
      '',
    ]) {
      expect(parseBondMetadata(bad)).toBeNull();
    }
  });
});

describe('certificate', () => {
  // Same inputs and expected values are pinned in test/CertificateVector.t.sol, which checks them with
  // abi.encodePacked and ecrecover. The digest here was produced by manual byte concatenation.
  const params = {
    domainSeparator: '0x' + '11'.repeat(32),
    msgSender: '0x00000000000000000000000000000000000A11CE',
    token: '0x000000000000000000000000000000000000DFAB',
    payload: '0x0102030405',
    expiry: 2000000000n,
    nonce: 7n,
  };
  const KEY = '0x00000000000000000000000000000000000000000000000000000000C0570D1A';
  const DIGEST = '0xddaa44b410b3e9fe06d836fcc8d71e4343a24f58b1757b285252b6e941a9fa7c';
  const CERT =
    '0x00000000000000000000000000000000000000000000000000000000773594007440fafcd4b250b61e5c90fe16b579ed2f89e7fbcb775173b7eaf2c5694733f1422c40d3ac9ae04a87702e59353bbb935efc24f6f5973aa1a369cb8f2ecbbcef1b';

  it('digest and certificate match the golden vector', () => {
    expect(certificateDigest(params)).toBe(DIGEST);
    expect(signCertificate(KEY, params)).toBe(CERT);
    expect(getBytes(CERT)).toHaveLength(CERTIFICATE_LENGTH);
  });

  it('the certificate recovers to the custodian key', () => {
    const b = getBytes(CERT);
    const r = hexlify(b.slice(32, 64));
    const s = hexlify(b.slice(64, 96));
    expect(recoverAddress(DIGEST, { r, s, v: b[96] })).toBe(computeAddress(new SigningKey(KEY).publicKey));
  });

  it('every parameter changes the digest', () => {
    const base = certificateDigest(params);
    expect(certificateDigest({ ...params, nonce: 8n })).not.toBe(base);
    expect(certificateDigest({ ...params, expiry: 2000000001n })).not.toBe(base);
    expect(certificateDigest({ ...params, payload: '0x0102030406' })).not.toBe(base);
    expect(certificateDigest({ ...params, msgSender: TOKEN })).not.toBe(base);
    expect(certificateDigest({ ...params, token: TOKEN })).not.toBe(base);
    expect(certificateDigest({ ...params, domainSeparator: '0x' + '22'.repeat(32) })).not.toBe(base);
  });

  it('throws on bad input', () => {
    expect(() => certificateDigest({ ...params, domainSeparator: '0x1234' })).toThrow();
    expect(() => certificateDigest({ ...params, msgSender: '0x1234' })).toThrow();
    expect(() => certificateDigest({ ...params, nonce: -1n })).toThrow();
    expect(() => certificateDigest({ ...params, expiry: 2n ** 256n })).toThrow();
  });

  it('payloadWithoutCertificate strips exactly the 160-byte tail of the real call layout', () => {
    const iface = new Interface([
      'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes data)',
    ]);
    const call = (data: Uint8Array) =>
      iface.encodeFunctionData('transferByPartitionStealth', [TRANCHE_A, TOKEN, 400n, '0x' + '02'.repeat(33), '0x20', data]);
    const withPlaceholder = call(new Uint8Array(CERTIFICATE_LENGTH));
    const withRealCert = call(getBytes(signCertificate(KEY, params)));
    // The signed payload is identical whatever the certificate bytes are.
    expect(payloadWithoutCertificate(withPlaceholder)).toBe(payloadWithoutCertificate(withRealCert));
    expect(getBytes(withPlaceholder).length - getBytes(payloadWithoutCertificate(withPlaceholder)).length).toBe(160);
    expect(() => payloadWithoutCertificate('0x' + '00'.repeat(160))).toThrow();
  });
});

describe('with scan', () => {
  it('scan still finds an announcement whose metadata is bond metadata', () => {
    const me = generateMetaAddress();
    const s = deriveStealth(me.metaAddress);
    const ann: Announcement = {
      schemeId: 1n,
      stealthAddress: s.stealthAddress,
      ephemeralPubKey: s.ephemeralPubKey,
      metadata: buildBondMetadata(s.viewTag, TOKEN, 400n, TRANCHE_A),
    };
    expect(scan([ann], me.viewKey, me.spendKey).map((f) => f.stealthAddress)).toEqual([s.stealthAddress]);
    expect(parseBondMetadata(ann.metadata)?.partition).toBe(TRANCHE_A);
  });
});
