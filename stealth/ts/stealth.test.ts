import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from './stealth.ts';

const V = {
  spend: '0x' + '11'.repeat(32),
  view: '0x' + '22'.repeat(32),
  eph: '0x' + '33'.repeat(32),
  meta: '0x034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
  ephPub: '0x023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1',
  tag: '0x20',
  address: '0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9',
  privateKey: '0x32074def70f9689560d0eb1b86aa895b735ed5852c9ce187ff0dcd968e8a19d3',
};

const toAnn = (s: ReturnType<typeof deriveStealth>): Announcement => ({
  schemeId: 1n,
  stealthAddress: s.stealthAddress,
  ephemeralPubKey: s.ephemeralPubKey,
  metadata: s.viewTag,
});

describe('reference vector (ScopeLift stealth-address-sdk)', () => {
  it('deriveStealth matches the reference', () => {
    expect(deriveStealth(V.meta, V.eph)).toEqual({
      stealthAddress: V.address,
      ephemeralPubKey: V.ephPub,
      viewTag: V.tag,
    });
  });

  it('scan recovers the reference address and private key', () => {
    const ann = toAnn(deriveStealth(V.meta, V.eph));
    expect(scan([ann], V.view, V.spend)).toEqual([{ stealthAddress: V.address, privateKey: V.privateKey }]);
  });

  it('accepts the st:eth: URI form', () => {
    expect(deriveStealth('st:eth:' + V.meta, V.eph).stealthAddress).toBe(V.address);
  });
});

describe('round trip', () => {
  // Review focus 5: two payments, two unlinkable addresses, both found.
  it('finds every payment; the recovered key controls the address', () => {
    const me = generateMetaAddress();
    const a = deriveStealth(me.metaAddress);
    const b = deriveStealth(me.metaAddress);
    expect(a.stealthAddress).not.toBe(b.stealthAddress);
    const found = scan([toAnn(a), toAnn(b)], me.viewKey, me.spendKey);
    expect(found.map((f) => f.stealthAddress)).toEqual([a.stealthAddress, b.stealthAddress]);
    for (const f of found) expect(new Wallet(f.privateKey).address).toBe(f.stealthAddress);
  });

  it('does not return payments meant for someone else', () => {
    const me = generateMetaAddress();
    const other = generateMetaAddress();
    expect(scan([toAnn(deriveStealth(other.metaAddress))], me.viewKey, me.spendKey)).toEqual([]);
  });

  it('skips announcements for other scheme ids', () => {
    const me = generateMetaAddress();
    const ann = { ...toAnn(deriveStealth(me.metaAddress)), schemeId: 2n };
    expect(scan([ann], me.viewKey, me.spendKey)).toEqual([]);
  });

  // schemeId read back from JSON is a number, not a bigint.
  it('accepts a non-bigint schemeId of 1 and still skips 2', () => {
    const me = generateMetaAddress();
    const ann = toAnn(deriveStealth(me.metaAddress));
    expect(scan([{ ...ann, schemeId: 1 as unknown as bigint }], me.viewKey, me.spendKey)).toHaveLength(1);
    expect(scan([{ ...ann, schemeId: 2n }], me.viewKey, me.spendKey)).toEqual([]);
  });

  // Anyone can re-post a real announcement; the payment must be reported once.
  it('returns a re-posted announcement once', () => {
    const me = generateMetaAddress();
    const ann = toAnn(deriveStealth(me.metaAddress));
    expect(scan([ann, ann], me.viewKey, me.spendKey)).toHaveLength(1);
  });

  it('throws on a malformed view key instead of returning []', () => {
    const me = generateMetaAddress();
    const ann = toAnn(deriveStealth(me.metaAddress));
    expect(() => scan([ann], '0x' + '22'.repeat(31), me.spendKey)).toThrow();
  });
});

describe('hostile input', () => {
  // Review focus 1: anyone can announce garbage; scan must skip it, never throw.
  it('skips malformed announcements without throwing', () => {
    const me = generateMetaAddress();
    const noise: Announcement[] = [
      { schemeId: 1n, stealthAddress: 'nonsense', ephemeralPubKey: '0x1234', metadata: '0x' },
      { schemeId: 1n, stealthAddress: V.address, ephemeralPubKey: '0x', metadata: '0x20' },
      { schemeId: 1n, stealthAddress: V.address, ephemeralPubKey: '0x05' + '00'.repeat(32), metadata: '0x20' },
      { schemeId: 1n, stealthAddress: V.address, ephemeralPubKey: V.ephPub, metadata: '0x' },
    ];
    expect(scan(noise, me.viewKey, me.spendKey)).toEqual([]);
  });

  // Review focus 2: right view tag, wrong address (the 1-in-256 collision) must not match.
  it('rejects a view-tag match whose address differs', () => {
    const ann = { ...toAnn(deriveStealth(V.meta, V.eph)), stealthAddress: '0x' + '00'.repeat(19) + '01' };
    expect(scan([ann], V.view, V.spend)).toEqual([]);
  });

  // Review focus 3: a bad meta-address must throw, never yield an unspendable address.
  it('deriveStealth throws on wrong length', () => {
    expect(() => deriveStealth('0x' + '02'.repeat(33))).toThrow(/66 bytes/);
  });

  it('deriveStealth throws on an off-curve key', () => {
    expect(() => deriveStealth('0x' + '05'.repeat(66))).toThrow();
  });

  // Valid view half, so only the spend-key check can throw.
  it('deriveStealth throws on an off-curve spend key with a valid view key', () => {
    const viewPub = generateMetaAddress().metaAddress.slice(2 + 66);
    const badSpend = '02' + '00'.repeat(31) + '05'; // x = 5 has no square root on secp256k1
    expect(() => deriveStealth('0x' + badSpend + viewPub)).toThrow(/square root/);
  });
});
