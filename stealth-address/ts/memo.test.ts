import { describe, expect, it } from 'vitest';
import { SigningKey, Wallet, concat, getBytes, hexlify, randomBytes, toBeHex } from 'ethers';
import { buildMemo, encryptMemo, memoDigest, openMemo, MAX_MEMO_LENGTH, type MemoContext } from './memo.ts';
import { deriveStealth, generateMetaAddress, scanAll, type Announcement } from './stealth.ts';
import { buildTokenMetadata, parseTokenMetadata } from './token.ts';
import { buildBondMetadata, parseBondMetadata } from './bond.ts';

const TOKEN = '0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9';
const TRANCHE_A = '0x' + Buffer.from('TRANCHE-A').toString('hex').padEnd(64, '0');

const bankA = new Wallet('0x' + 'a1'.repeat(32)); // the sender bank's identity key
const receiver = generateMetaAddress(); // bank B
const bi = receiver; // BI holds B's view key: same viewKey, no spend key needed to read memos
const thirdBank = generateMetaAddress();

const eph = hexlify(randomBytes(32));
const s = deriveStealth(receiver.metaAddress, eph);
const ctx: MemoContext = { chainId: 1337n, token: TOKEN, stealthAddress: s.stealthAddress, amount: 400n, ephemeralPubKey: s.ephemeralPubKey };
const memo = buildMemo({ senderKey: bankA.privateKey, ephemeralKey: eph, receiverMetaAddress: receiver.metaAddress, ctx });

describe('encrypted sender memo', () => {
  it('has the documented size: version 1 + sender 20 + signature 65 + GCM tag 16 = 102 bytes, under the bound', () => {
    expect(getBytes(memo).length).toBe(102);
    expect(getBytes(memo)[0]).toBe(1);
    expect(getBytes(memo).length).toBeLessThanOrEqual(MAX_MEMO_LENGTH);
  });

  it('receiver (view key) and BI (the same view key) both open it and learn the authenticated sender', () => {
    expect(openMemo(memo, receiver.viewKey, ctx)).toEqual({ sender: bankA.address });
    expect(openMemo(memo, bi.viewKey, ctx)).toEqual({ sender: bankA.address });
  });

  it('a third bank cannot open it, and the plaintext sender is not visible in the memo bytes', () => {
    expect(openMemo(memo, thirdBank.viewKey, ctx)).toBeNull();
    expect(memo.toLowerCase().includes(bankA.address.slice(2).toLowerCase())).toBe(false);
  });

  it('a tampered memo fails GCM authentication (every byte position)', () => {
    const b = getBytes(memo);
    for (const i of [0, 1, 40, 85, 101]) {
      const bad = new Uint8Array(b);
      bad[i] ^= 0x01;
      expect(openMemo(hexlify(bad), receiver.viewKey, ctx)).toBeNull();
    }
    expect(openMemo(hexlify(b.slice(0, 101)), receiver.viewKey, ctx)).toBeNull(); // truncated
    expect(openMemo('0x', receiver.viewKey, ctx)).toBeNull();
    expect(openMemo('not hex', receiver.viewKey, ctx)).toBeNull();
  });

  it('a forged sender is rejected: a valid GCM memo whose signature is not by the claimed sender', () => {
    // Mallory knows the receiver meta-address (public) so she can encrypt a perfectly valid memo, but she cannot
    // sign as bank A. She signs with her own key while the plaintext claims bank A.
    const mallory = new Wallet('0x' + 'bb'.repeat(32));
    const sig = new SigningKey(mallory.privateKey).sign(memoDigest(ctx));
    const forged = encryptMemo(getBytes(concat([bankA.address, sig.r, sig.s, toBeHex(sig.v, 1)])), eph, receiver.metaAddress);
    expect(openMemo(forged, receiver.viewKey, ctx)).toBeNull();
    // signing honestly as herself yields Mallory, never bank A
    const honest = buildMemo({ senderKey: mallory.privateKey, ephemeralKey: eph, receiverMetaAddress: receiver.metaAddress, ctx });
    expect(openMemo(honest, receiver.viewKey, ctx)).toEqual({ sender: mallory.address });
  });

  it('the signature binds chain, token, stealth address, amount, ephemeral key and partition', () => {
    for (const changed of [
      { ...ctx, chainId: 1n },
      { ...ctx, token: '0x' + '11'.repeat(20) },
      { ...ctx, stealthAddress: '0x' + '22'.repeat(20) },
      { ...ctx, amount: 401n },
      { ...ctx, partition: TRANCHE_A },
    ]) {
      expect(openMemo(memo, receiver.viewKey, changed)).toBeNull();
    }
    expect(new Set([memoDigest(ctx), memoDigest({ ...ctx, partition: TRANCHE_A })]).size).toBe(2);
  });

  it('a memo cannot be replayed onto another payment (different ephemeral key)', () => {
    const other = deriveStealth(receiver.metaAddress);
    expect(openMemo(memo, receiver.viewKey, { ...ctx, stealthAddress: other.stealthAddress, ephemeralPubKey: other.ephemeralPubKey })).toBeNull();
  });

  it('refuses to build a memo whose context ephemeral key is not the one used for encryption', () => {
    const other = deriveStealth(receiver.metaAddress);
    expect(() => buildMemo({ senderKey: bankA.privateKey, ephemeralKey: eph, receiverMetaAddress: receiver.metaAddress, ctx: { ...ctx, ephemeralPubKey: other.ephemeralPubKey } })).toThrow();
  });
});

describe('memo inside announcement metadata (RD 57-byte and DFABI 89-byte prefixes stay exact)', () => {
  it('RD: prefix parses unchanged, memo is the tail, scanners still match on byte 0', () => {
    const md = buildTokenMetadata(s.viewTag, TOKEN, 400n, memo);
    expect(getBytes(md).length).toBe(57 + 102);
    expect(md.startsWith(buildTokenMetadata(s.viewTag, TOKEN, 400n))).toBe(true);
    expect(parseTokenMetadata(md)).toEqual({ viewTag: s.viewTag, token: TOKEN, amount: 400n, memo });
    const ann: Announcement = { schemeId: 1n, stealthAddress: s.stealthAddress, ephemeralPubKey: s.ephemeralPubKey, metadata: md };
    expect(scanAll([ann], [{ id: 'B', viewKey: receiver.viewKey, metaAddress: receiver.metaAddress }]).length).toBe(1);
  });

  it('DFABI: prefix parses unchanged, memo is the tail', () => {
    const md = buildBondMetadata(s.viewTag, TOKEN, 400n, TRANCHE_A, memo);
    expect(getBytes(md).length).toBe(89 + 102);
    expect(parseBondMetadata(md)).toEqual({ viewTag: s.viewTag, token: TOKEN, amount: 400n, partition: TRANCHE_A, memo });
  });

  it('a metadata with a memo over the bound is not token metadata', () => {
    expect(() => buildTokenMetadata(s.viewTag, TOKEN, 1n, '0x' + '00'.repeat(257))).toThrow();
    expect(parseTokenMetadata(buildTokenMetadata(s.viewTag, TOKEN, 1n) + '00'.repeat(257))).toBeNull();
    expect(parseBondMetadata(buildBondMetadata(s.viewTag, TOKEN, 1n, TRANCHE_A) + '00'.repeat(257))).toBeNull();
  });
});
