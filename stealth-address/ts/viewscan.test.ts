import { describe, expect, it } from 'vitest';
import { deriveStealth, generateMetaAddress, scan, scanAll, scanView, type Announcement } from './stealth.ts';

const ann = (s: ReturnType<typeof deriveStealth>): Announcement => ({
  schemeId: 1n,
  stealthAddress: s.stealthAddress,
  ephemeralPubKey: s.ephemeralPubKey,
  metadata: s.viewTag,
});

// BI holds each bank's view key and meta-address (spend PUBLIC key inside), never a spend private key.
describe('view-key scan (BI sees every receiver)', () => {
  const a = generateMetaAddress();
  const b = generateMetaAddress();
  const other = generateMetaAddress(); // a bank BI has no view key for
  const toA1 = deriveStealth(a.metaAddress);
  const toA2 = deriveStealth(a.metaAddress);
  const toB = deriveStealth(b.metaAddress);
  const toOther = deriveStealth(other.metaAddress);
  const anns = [ann(toA1), ann(toB), ann(toOther), ann(toA2)];
  const holders = [
    { id: 'bank-A', viewKey: a.viewKey, metaAddress: a.metaAddress },
    { id: 'bank-B', viewKey: b.viewKey, metaAddress: b.metaAddress },
  ];

  it('scanView returns exactly that bank announcements, same ones the bank itself finds', () => {
    const forA = scanView(anns, holders[0]).map((x) => x.stealthAddress);
    expect(forA).toEqual([toA1.stealthAddress, toA2.stealthAddress]);
    expect(scan(anns, a.viewKey, a.spendKey).map((f) => f.stealthAddress)).toEqual(forA);
  });

  it('scanAll resolves every announcement to its bank and leaves unknown banks out', () => {
    const all = scanAll(anns, holders);
    expect(all.map((r) => [r.bank, r.announcement.stealthAddress])).toEqual([
      ['bank-A', toA1.stealthAddress],
      ['bank-A', toA2.stealthAddress],
      ['bank-B', toB.stealthAddress],
    ]);
  });

  it('a view key of another bank finds nothing', () => {
    const mixed = { id: 'x', viewKey: b.viewKey, metaAddress: b.metaAddress };
    expect(scanView([ann(toA1), ann(toA2)], mixed)).toEqual([]);
  });

  it('refuses a view key that does not belong to the meta-address', () => {
    expect(() => scanView(anns, { id: 'bank-A', viewKey: b.viewKey, metaAddress: a.metaAddress })).toThrow(/bank-A/);
  });

  it('accepts the st:eth: form and skips re-posted and malformed announcements', () => {
    const noisy = [...anns, ann(toA1), { ...ann(toA1), ephemeralPubKey: '0x1234' }, { ...ann(toA1), metadata: '0x' }];
    const r = scanView(noisy, { id: 'bank-A', viewKey: a.viewKey, metaAddress: 'st:eth:' + a.metaAddress });
    expect(r.map((x) => x.stealthAddress)).toEqual([toA1.stealthAddress, toA2.stealthAddress]);
  });

  it('cannot produce a spend key: results carry no private key', () => {
    const r = scanAll(anns, holders)[0] as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(['announcement', 'bank']);
  });
});
