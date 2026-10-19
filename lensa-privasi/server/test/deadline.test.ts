import { afterEach, expect, test, vi } from 'vitest';
import { DeadlineError, withDeadline } from '../src/deadline.ts';

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
