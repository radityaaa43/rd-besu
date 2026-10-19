import { afterEach, expect, test, vi } from 'vitest';
import { DeadlineError, afterLock, withDeadline } from '../src/deadline.ts';

afterEach(() => vi.useRealTimers());

test('resolves before deadline', async () => {
  await expect(withDeadline(Promise.resolve(1), 50, 'x')).resolves.toBe(1);
});
test('rejects after deadline', async () => {
  vi.useFakeTimers();
  const p = withDeadline(new Promise(() => {}), 1000, 'Receipt');
  const assertion = expect(p).rejects.toSatisfy((e) => e instanceof DeadlineError && e.message === 'Receipt tidak selesai dalam 1 detik');
  vi.advanceTimersByTime(1000);
  await assertion;
});
test('clears timer on resolve', async () => {
  vi.useFakeTimers();
  await withDeadline(Promise.resolve(1), 1000, 'x');
  expect(vi.getTimerCount()).toBe(0);
});

test('afterLock does not charge time before armed()', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const p = afterLock(1000, 'Kerja', async (armed) => { await gate; armed(); await new Promise((r) => setTimeout(r, 500)); return 'ok'; });
  await vi.advanceTimersByTimeAsync(5000); // long lock wait
  release();
  await vi.advanceTimersByTimeAsync(500);
  await expect(p).resolves.toBe('ok');
  expect(vi.getTimerCount()).toBe(0);
});
test('afterLock rejects 1 s after armed()', async () => {
  vi.useFakeTimers();
  const p = afterLock(1000, 'Kerja', async (armed) => { armed(); await new Promise(() => {}); });
  const assertion = expect(p).rejects.toBeInstanceOf(DeadlineError);
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});
