import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ModelAdapter } from '../src/adapter.ts';
import type { BankId, ModelId } from '../src/domain.ts';
import type { Sample } from '../src/stats.ts';
import { StressRun, validateStress, type StressConfig } from '../src/stress.ts';
import { fakeAdapter } from './fake-adapter.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const cfg = (o: Partial<StressConfig> = {}): StressConfig => ({ models: ['zeto'], count: 10, concurrency: 1, limitS: 300, ...o });
const finish = async (run: StressRun) => { const p = run.start(); await vi.runAllTimersAsync(); return p; };

type Call = { from: BankId; to: BankId; at: number };
// Wraps an adapter to record calls, confirmed samples and the max number of calls in flight.
function spy(a: ModelAdapter) {
  const calls: Call[] = [];
  const samples: Sample[] = [];
  const st = { inflight: 0, maxInflight: 0 };
  const orig = a.transferForLoad.bind(a);
  a.transferForLoad = async (from, to, amount) => {
    calls.push({ from, to, at: Date.now() });
    st.maxInflight = Math.max(st.maxInflight, ++st.inflight);
    try { const s = await orig(from, to, amount); samples.push(s); return s; } finally { st.inflight--; }
  };
  return { calls, samples, st };
}

test('runs models sequentially', async () => {
  const z = fakeAdapter('zeto'), n = fakeAdapter('noto');
  const sz = spy(z), sn = spy(n);
  const snap = await finish(new StressRun(cfg({ models: ['zeto', 'noto'], count: 5, concurrency: 2 }), { zeto: z, noto: n }));
  expect(snap.state).toBe('done');
  expect(snap.models.zeto?.summary.ok).toBe(5);
  expect(snap.models.noto?.summary.ok).toBe(5);
  const lastZeto = Math.max(...sz.samples.map((s) => s.confirmedAt));
  expect(sn.calls[0].at).toBeGreaterThanOrEqual(lastZeto);
});

test('respects count and concurrency', async () => {
  const z = fakeAdapter('zeto');
  const s = spy(z);
  const snap = await finish(new StressRun(cfg({ count: 10, concurrency: 2 }), { zeto: z }));
  expect(snap.models.zeto?.summary.ok).toBe(10);
  expect(s.calls).toHaveLength(10);
  expect(s.st.maxInflight).toBe(2);
});

test('rotates pairs', async () => {
  const z = fakeAdapter('zeto');
  const s = spy(z);
  await finish(new StressRun(cfg({ count: 3, concurrency: 1 }), { zeto: z }));
  expect(s.calls.map((c) => `${c.from}${c.to}`)).toEqual(['AB', 'BC', 'CA']);
});

test('counts failures and keeps first error', async () => {
  const z = fakeAdapter('zeto', { failEvery: 3 });
  const snap = await finish(new StressRun(cfg({ count: 9 }), { zeto: z }));
  const m = snap.models.zeto!;
  expect(m.summary.failed).toBe(3);
  expect(m.summary.ok).toBe(6);
  expect(m.firstError).toBe('gagal simulasi');
  expect(m.status).toBe('done');
});

test('time limit gives timeout', async () => {
  const z = fakeAdapter('zeto', { tps: 1 }); // 1 s per call
  const snap = await finish(new StressRun(cfg({ count: 1000, limitS: 120 }), { zeto: z }));
  const m = snap.models.zeto!;
  expect(m.status).toBe('timeout');
  expect(m.summary.ok).toBe(120);
  expect(m.elapsedS).toBe(120);
});

test('stop gives stopped and drains', async () => {
  const z = fakeAdapter('zeto', { tps: 1 });
  const run = new StressRun(cfg({ count: 100, concurrency: 2 }), { zeto: z });
  const p = run.start();
  await vi.advanceTimersByTimeAsync(500);
  run.stop();
  await vi.runAllTimersAsync();
  const snap = await p;
  expect(snap.state).toBe('stopped');
  expect(snap.models.zeto?.status).toBe('stopped');
  expect(snap.models.zeto?.summary.ok).toBe(2); // both in-flight calls drained
});

test('stop gives up on calls still in flight after 30 s', async () => {
  const z = fakeAdapter('zeto');
  z.transferForLoad = () => new Promise(() => {}); // never resolves
  const run = new StressRun(cfg({ count: 100, concurrency: 2 }), { zeto: z });
  const p = run.start();
  await vi.advanceTimersByTimeAsync(1000);
  run.stop();
  await vi.advanceTimersByTimeAsync(30_000);
  const m = (await p).models.zeto!;
  expect(m.status).toBe('stopped');
  expect(m.summary.failed).toBe(2);
  expect(m.firstError).toBe('Dihentikan sebelum selesai');
});

test('skips unready model with reason', async () => {
  const snap = await finish(new StressRun(cfg({ models: ['noto', 'zeto'] }), { noto: fakeAdapter('noto', { ready: false }), zeto: fakeAdapter('zeto') }));
  expect(snap.models.noto).toMatchObject({ status: 'skipped', reason: 'node mati' });
  expect(snap.models.zeto?.status).toBe('done');
});

test('emits at most one tick per second and a final done', async () => {
  const z = fakeAdapter('zeto', { tps: 10 });
  const run = new StressRun(cfg({ count: 50 }), { zeto: z }); // ~5 s
  const ticks = vi.fn(), done = vi.fn();
  run.on('tick', ticks); run.on('done', done);
  await finish(run);
  expect(ticks.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(ticks.mock.calls.length).toBeLessThanOrEqual(6);
  expect(done).toHaveBeenCalledTimes(1);
  expect(done.mock.calls[0][0].state).toBe('done');
});

test('hung health() is skipped after 10 s, next model still runs, done emitted', async () => {
  const n = fakeAdapter('noto');
  n.health = () => new Promise(() => {});
  const run = new StressRun(cfg({ models: ['noto', 'zeto'], count: 3 }), { noto: n, zeto: fakeAdapter('zeto') });
  const done = vi.fn();
  run.on('done', done);
  const snap = await finish(run);
  expect(snap.models.noto).toMatchObject({ status: 'skipped', reason: 'Cek kesiapan tidak selesai dalam 10 detik' });
  expect(snap.models.zeto?.summary.ok).toBe(3);
  expect(done).toHaveBeenCalledTimes(1);
});

test('rejecting health() is skipped with the error message, next model still runs, done emitted', async () => {
  const n = fakeAdapter('noto');
  n.health = () => Promise.reject(new Error('port-forward putus'));
  const run = new StressRun(cfg({ models: ['noto', 'zeto'], count: 3 }), { noto: n, zeto: fakeAdapter('zeto') });
  const done = vi.fn();
  run.on('done', done);
  const snap = await finish(run);
  expect(snap.models.noto).toMatchObject({ status: 'skipped', reason: 'port-forward putus' });
  expect(snap.models.zeto?.summary.ok).toBe(3);
  expect(done).toHaveBeenCalledTimes(1);
});

const cap: Partial<Record<ModelId, number>> = { zeto: 100, noto: 500, stealth: 500 };

test('rejects count above capacity', () => {
  expect(validateStress(cfg({ count: 200 }), cap)).toEqual({ ok: false, reason: 'Melebihi kapasitas siap Zeto (100 tx)' });
  expect(validateStress(cfg({ count: 100 }), cap)).toEqual({ ok: true });
});

test('rejects empty model list, zero count and unavailable model', () => {
  expect(validateStress(cfg({ models: [] }), cap)).toEqual({ ok: false, reason: 'Pilih minimal satu model' });
  expect(validateStress(cfg({ count: 0 }), cap)).toEqual({ ok: false, reason: 'Jumlah transaksi minimal 1' });
  expect(validateStress(cfg({ count: 2.5 }), cap)).toEqual({ ok: false, reason: 'Jumlah transaksi minimal 1' });
  expect(validateStress(cfg({ count: Infinity }), cap)).toEqual({ ok: false, reason: 'Jumlah transaksi minimal 1' });
  expect(validateStress(cfg({ models: ['stealth'] }), { zeto: 100 })).toEqual({ ok: false, reason: 'Stealth belum tersedia' });
});
