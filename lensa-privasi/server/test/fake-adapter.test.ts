import { expect, test, vi } from 'vitest';
import { fakeAdapter } from './fake-adapter.ts';

test('run calls onStep with exactly one argument per step', async () => {
  const spy = vi.fn();
  const res = await fakeAdapter('zeto').run({ model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1' }, 1n, spy);
  expect(spy).toHaveBeenCalledTimes(4);
  expect(spy.mock.calls.every((c) => c.length === 1)).toBe(true);
  expect(spy).toHaveBeenNthCalledWith(1, res.steps[0]);
});
