import { describe, expect, it } from 'vitest';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from './stealth.ts';
import { buildTokenMetadata, parseTokenMetadata } from './token.ts';

const TOKEN = '0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9';
const GOLDEN =
  '0x20a9059cbbd8606ed2ecdb71fdcb8cca8fa1925ff84238f2a900000000000000000000000000000000000000000000000000000000000003e8';

describe('buildTokenMetadata', () => {
  it('matches the golden 57-byte vector', () => {
    expect(buildTokenMetadata('0x20', TOKEN, 1000n)).toBe(GOLDEN);
    expect((GOLDEN.length - 2) / 2).toBe(57);
  });

  it('accepts the extremes 0 and 2^256-1', () => {
    expect(buildTokenMetadata('0x00', TOKEN, 0n)).toHaveLength(2 + 57 * 2);
    expect(buildTokenMetadata('0xff', TOKEN, 2n ** 256n - 1n).endsWith('ff'.repeat(32))).toBe(true);
  });

  it('throws on bad input', () => {
    expect(() => buildTokenMetadata('0x2000', TOKEN, 1n)).toThrow();
    expect(() => buildTokenMetadata('0x', TOKEN, 1n)).toThrow();
    expect(() => buildTokenMetadata('0x20', '0x1234', 1n)).toThrow();
    expect(() => buildTokenMetadata('0x20', TOKEN, -1n)).toThrow();
    expect(() => buildTokenMetadata('0x20', TOKEN, 2n ** 256n)).toThrow();
  });
});

describe('parseTokenMetadata', () => {
  it('round-trips', () => {
    expect(parseTokenMetadata(buildTokenMetadata('0x7f', TOKEN, 123456789n))).toEqual({
      viewTag: '0x7f',
      token: TOKEN,
      amount: 123456789n,
    });
  });

  it('parses the golden vector', () => {
    expect(parseTokenMetadata(GOLDEN)).toEqual({ viewTag: '0x20', token: TOKEN, amount: 1000n });
  });

  // Review focus 4: never throws, always null for anything that is not the 57-byte ERC-20 form.
  it('returns null for anything else', () => {
    const body = GOLDEN.slice(2);
    for (const bad of [
      '0x',
      '0x20', // tag-only metadata from sub-project 1
      '0x' + body.slice(0, 56 * 2), // 56 bytes
      GOLDEN + '00', // 58 bytes
      '0x20' + 'deadbeef' + body.slice(10), // wrong selector
      'not hex',
      '',
    ]) {
      expect(parseTokenMetadata(bad)).toBeNull();
    }
  });
});

describe('with scan', () => {
  it('scan still finds an announcement whose metadata is token metadata', () => {
    const me = generateMetaAddress();
    const s = deriveStealth(me.metaAddress);
    const ann: Announcement = {
      schemeId: 1n,
      stealthAddress: s.stealthAddress,
      ephemeralPubKey: s.ephemeralPubKey,
      metadata: buildTokenMetadata(s.viewTag, TOKEN, 400n),
    };
    const found = scan([ann], me.viewKey, me.spendKey);
    expect(found.map((f) => f.stealthAddress)).toEqual([s.stealthAddress]);
    expect(parseTokenMetadata(ann.metadata)?.amount).toBe(400n);
  });
});
