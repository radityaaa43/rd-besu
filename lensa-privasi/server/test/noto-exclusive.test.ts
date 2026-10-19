import { describe, expect, it } from 'vitest';
import { exclusive } from '../src/adapters/noto.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('noto exclusive', () => {
  it('keeps the lock until a held promise settles, even after fn threw', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const first = exclusive(['A', 'B'], async (hold) => { hold(slow.then(() => { order.push('slow done'); })); throw new Error('timeout'); });
    await expect(first).rejects.toThrow('timeout');
    const second = exclusive(['B'], async () => { order.push('second'); });
    await sleep(50);
    expect(order).toEqual([]); // second still queued behind the held work
    release();
    await second;
    expect(order).toEqual(['slow done', 'second']);
  });

  it('serialises same-sender work and lets different senders overlap', async () => {
    const order: string[] = [];
    const job = (keys: ('A' | 'B')[], name: string) => exclusive(keys, async () => { order.push(`${name}+`); await sleep(30); order.push(`${name}-`); });
    await Promise.all([job(['A'], 'a1'), job(['A'], 'a2'), job(['B'], 'b1')]);
    expect(order.indexOf('a1-')).toBeLessThan(order.indexOf('a2+'));
    expect(order.indexOf('b1+')).toBeLessThan(order.indexOf('a1-'));
  });
});
