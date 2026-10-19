import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { biRows, pay, read } from './chain.ts';
import { buildBondMetadata } from './bond.ts';
import { generateMetaAddress, scan, type Announcement, type ViewKeyHolder } from './stealth.ts';
import { buildTokenMetadata } from './token.ts';

const CHAIN = 1337n;
const RD = Wallet.createRandom().address;
const BOND = Wallet.createRandom().address;
const PARTITION = '0x' + '11'.repeat(32);
const bankA = generateMetaAddress();
const bankB = generateMetaAddress();
const sender = Wallet.createRandom();

const toAnn = (p: ReturnType<typeof pay>, metadata: string): Announcement =>
  ({ schemeId: 1n, stealthAddress: p.s.stealthAddress, ephemeralPubKey: p.s.ephemeralPubKey, metadata });

describe('pay + read', () => {
  it('receiver reads amount and authenticated sender of an RD payment', () => {
    const p = pay(CHAIN, bankA.metaAddress, sender.privateKey, RD, 1234n);
    const ann = toAnn(p, buildTokenMetadata(p.s.viewTag, RD, 1234n, p.memo));
    const [found] = scan([ann], bankA.viewKey, bankA.spendKey);
    expect(found.stealthAddress).toBe(p.s.stealthAddress);
    const r = read(CHAIN, ann, bankA.viewKey, 'rd');
    expect(r.amount).toBe(1234n);
    expect(r.sender).toBe(sender.address);
  });

  it('a bank without the view key reads the amount but not the sender', () => {
    const p = pay(CHAIN, bankA.metaAddress, sender.privateKey, BOND, 7n, PARTITION);
    const ann = toAnn(p, buildBondMetadata(p.s.viewTag, BOND, 7n, PARTITION, p.memo));
    expect(read(CHAIN, ann, bankB.viewKey, 'bond')).toMatchObject({ amount: 7n, partition: PARTITION, sender: null });
  });
});

describe('biRows', () => {
  it('resolves each announcement to its bank with amount and sender', () => {
    const holders: ViewKeyHolder[] = [
      { id: 'A', viewKey: bankA.viewKey, metaAddress: bankA.metaAddress },
      { id: 'B', viewKey: bankB.viewKey, metaAddress: bankB.metaAddress },
    ];
    const pa = pay(CHAIN, bankA.metaAddress, sender.privateKey, RD, 10n);
    const pb = pay(CHAIN, bankB.metaAddress, sender.privateKey, RD, 20n);
    const anns = [toAnn(pa, buildTokenMetadata(pa.s.viewTag, RD, 10n, pa.memo)), toAnn(pb, buildTokenMetadata(pb.s.viewTag, RD, 20n, pb.memo))];
    const rows = biRows(CHAIN, anns, holders, 'rd');
    expect(rows.map((r) => [r.bank, r.amount, r.sender])).toEqual([['A', 10n, sender.address], ['B', 20n, sender.address]]);
  });
});
