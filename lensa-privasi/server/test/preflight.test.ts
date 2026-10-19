import { expect, test, vi } from 'vitest';
import { runPreflight } from '../src/cli/preflight.ts';
import { fakeAdapter } from './fake-adapter.ts';

const up = async () => ({ besu: true, paladin: [true, true, true, true] });
const run = async (adapters: Parameters<typeof runPreflight>[0], opts = {}, probe = up) => {
  const lines: string[] = [];
  const code = await runPreflight(adapters, probe, opts, (l) => lines.push(l));
  return { code, out: lines.join('\n') };
};

test('a model that is not ready fails the run', async () => {
  const { code, out } = await run({ zeto: fakeAdapter('zeto'), noto: fakeAdapter('noto', { ready: false }), stealth: fakeAdapter('stealth') });
  expect(code).toBe(1);
  expect(out).toContain('GAGAL Noto: node mati');
});

test('everything ready exits 0 and prints each capacity', async () => {
  const { code, out } = await run({ zeto: fakeAdapter('zeto', { capacity: 7 }), noto: fakeAdapter('noto', { capacity: 8 }), stealth: fakeAdapter('stealth', { capacity: 9 }) });
  expect(code).toBe(0);
  expect(out).toContain('OK Paladin node 4');
  expect(out).toContain('OK Besu');
  for (const l of ['Zeto: 7', 'Noto: 8', 'Stealth: 9']) expect(out).toContain(`OK Kapasitas ${l} tx`);
});

test('a missing adapter and a dead node are reported', async () => {
  const { code, out } = await run({ zeto: fakeAdapter('zeto'), stealth: fakeAdapter('stealth') }, {}, async () => ({ besu: false, paladin: [true, false, true, true] }));
  expect(code).toBe(1);
  expect(out).toContain('GAGAL Noto belum tersedia');
  expect(out).toContain('GAGAL Paladin node 2');
  expect(out).toContain('GAGAL Besu');
});

test('--prepare N prepares ready models only, then prints the new capacity', async () => {
  const ok = fakeAdapter('zeto'); const bad = fakeAdapter('noto', { ready: false });
  const spyOk = vi.spyOn(ok, 'prepareLoad'); const spyBad = vi.spyOn(bad, 'prepareLoad');
  const { code, out } = await run({ zeto: ok, noto: bad }, { prepare: 5 });
  expect(spyOk).toHaveBeenCalledWith(5);
  expect(spyBad).not.toHaveBeenCalled();
  expect(out).toContain('OK Kapasitas Zeto: 1000 tx');
  expect(code).toBe(1);
});
