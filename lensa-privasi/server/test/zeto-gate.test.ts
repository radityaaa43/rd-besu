import { expect, it } from 'vitest';
import { exclusive } from '../src/adapters/zeto.ts';

// Concurrency gate: at most 2 Zeto ops overall, at most 1 per sender bank (N6 duplicate-input guard).
async function peak(jobs: ('A' | 'B' | 'C')[][]) {
  let now = 0, max = 0, perMax = 0;
  const per = new Map<string, number>();
  await Promise.all(jobs.map((senders) => exclusive(senders, async () => {
    now++; max = Math.max(max, now);
    for (const s of senders) { per.set(s, (per.get(s) ?? 0) + 1); perMax = Math.max(perMax, per.get(s)!); }
    await new Promise((r) => setTimeout(r, 20));
    for (const s of senders) per.set(s, per.get(s)! - 1);
    now--;
  })));
  return { max, perMax };
}

it('one sender is serialised', async () => {
  expect(await peak([['A'], ['A'], ['A'], ['A']])).toEqual({ max: 1, perMax: 1 });
});

it('different senders run at most 2 at a time', async () => {
  const r = await peak([['A'], ['B'], ['C'], ['A'], ['B'], ['C']]);
  expect(r.max).toBe(2);
  expect(r.perMax).toBe(1);
});

it('two-party DvPs in opposite order do not deadlock and keep one per sender', async () => {
  expect((await peak([['A', 'B'], ['B', 'A'], ['A', 'B']])).perMax).toBe(1);
});
