import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ModelAdapter } from '../src/adapter.ts';
import { buildApp, rpcUp } from '../src/app.ts';
import type { FlowRequest, ModelId } from '../src/domain.ts';
import { fakeAdapter } from './fake-adapter.ts';

const probe = async () => ({ besu: true, paladin: [true, true, true, true] });
const req: FlowRequest = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '100' };

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const make = (adapters: Partial<Record<ModelId, ModelAdapter>> = { zeto: fakeAdapter('zeto') }, opts: { webDist?: string } = {}) =>
  (app = buildApp(adapters, { probe, ...opts }));
const all = () => ({ zeto: fakeAdapter('zeto'), noto: fakeAdapter('noto'), stealth: fakeAdapter('stealth') });
const post = (a: FastifyInstance, url: string, payload: unknown) => a.inject({ method: 'POST', url, payload: payload as object });
const listen = async (a: FastifyInstance) => a.listen({ port: 0, host: '127.0.0.1' });

// adapter whose run() waits for the returned release()
function gated(a: ModelAdapter) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const run = a.run.bind(a);
  a.run = async (...args) => { await gate; return run(...args); };
  return release;
}

type Sse = { event: string; data: any };
async function readSse(base: string, path: string): Promise<Sse[]> {
  const text = await (await fetch(base + path)).text();
  return text.split('\n\n').filter((b) => b && !b.startsWith(':')).map((b) => {
    const lines = b.split('\n');
    return {
      event: lines.find((l) => l.startsWith('event: '))!.slice(7),
      data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)),
    };
  });
}
async function stressState(a: FastifyInstance) {
  for (let i = 0; i < 200; i++) {
    const s = (await a.inject('/api/stress')).json();
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('stress did not finish');
}

test('meta lists 3 models with step labels', async () => {
  const res = await make(all()).inject('/api/meta');
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(Object.keys(body.models).sort()).toEqual(['noto', 'stealth', 'zeto']);
  expect(body.models.zeto).toMatchObject({ name: 'Zeto', available: true, stepLabels: ['Siapkan', 'Kirim', 'Konfirmasi', 'Selesai'] });
  expect(body.models.zeto.capabilities['dvp']).toEqual({ enabled: true });
  expect(body.parties.A.name).toBe('Bank Mandala');
  expect(Object.keys(body.flows)).toHaveLength(5);
});

test('meta marks a missing adapter as unavailable', async () => {
  const body = (await make().inject('/api/meta')).json();
  expect(body.models.noto).toMatchObject({ name: 'Noto', available: false, stepLabels: [] });
  expect(body.models.noto.capabilities.dvp).toEqual({ enabled: false, reason: 'Belum tersedia' });
});

test('health reports models and nodes', async () => {
  const body = (await make({ zeto: fakeAdapter('zeto', { ready: false }) }).inject('/api/health')).json();
  expect(body.models.zeto).toEqual({ ready: false, detail: 'node mati' });
  expect(body.models.noto).toEqual({ ready: false, detail: 'Belum tersedia' });
  expect(body.nodes).toEqual({ besu: true, paladin: [true, true, true, true] });
});

test('health answers within 4 s with nodes even when an adapter health never resolves', async () => {
  const z = fakeAdapter('zeto');
  z.health = () => new Promise(() => {});
  const t0 = Date.now();
  const body = (await make({ zeto: z }).inject('/api/health')).json();
  expect(Date.now() - t0).toBeLessThan(4000);
  expect(body.nodes).toEqual({ besu: true, paladin: [true, true, true, true] });
  expect(body.models.zeto).toEqual({ ready: false, detail: 'Cek kesiapan tidak selesai dalam 3 detik' });
});

test('400 on bad amount', async () => {
  const res = await post(make(), '/api/tx', { ...req, amount: '0' });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ reason: 'Nominal harus lebih dari 0' });
});

test('400 with Indonesian reason on schema violations', async () => {
  const a = make();
  for (const bad of [{ ...req, flow: 'redeem' }, { ...req, amount: 5 }, { ...req, extra: 1 }, { model: 'zeto' }]) {
    const res = await post(a, '/api/tx', bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toMatch(/^Permintaan tidak valid: /);
  }
});

test('409 on disabled flow', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { disabled: { 'dfabi-transfer': 'X' } }) });
  const res = await post(a, '/api/tx', { ...req, flow: 'dfabi-transfer' });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ reason: 'Alur ini tidak tersedia: X' });
});

test('503 when adapter not ready', async () => {
  const res = await post(make({ zeto: fakeAdapter('zeto', { ready: false }) }), '/api/tx', req);
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ reason: 'Zeto belum siap: node mati' });
});

test('503 when the model has no adapter', async () => {
  const res = await post(make(), '/api/tx', { ...req, model: 'noto' });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ reason: 'Noto belum tersedia' });
});

test('400 when balance too low', async () => {
  const z = fakeAdapter('zeto');
  z.balanceOf = async () => 99n;
  const res = await post(make({ zeto: z }), '/api/tx', req);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ reason: 'Saldo Bank Mandala tidak cukup' });
});

test('dvp checks buyer RD at amount x price and seller DFABI', async () => {
  const z = fakeAdapter('zeto');
  z.balanceOf = async (_p, asset) => (asset === 'RD' ? 499_999n : 10n ** 18n);
  const a = make({ zeto: z });
  const res = await post(a, '/api/tx', { ...req, flow: 'dvp', amount: '1' });
  expect(res.json()).toEqual({ reason: 'Saldo Bank Nusantara tidak cukup' });
  z.balanceOf = async (_p, asset) => (asset === 'RD' ? 10n ** 18n : 0n);
  expect((await post(a, '/api/tx', { ...req, flow: 'dvp', amount: '1' })).json()).toEqual({ reason: 'Saldo Bank Mandala tidak cukup' });
});

test('issue flows skip the balance check', async () => {
  const z = fakeAdapter('zeto');
  z.balanceOf = async () => 0n;
  const res = await post(make({ zeto: z }), '/api/tx', { ...req, flow: 'rd-issue', from: 'BI' });
  expect(res.statusCode).toBe(202);
});

test('202 then SSE delivers 4 steps and result with 4 lenses in order BI,A,B,C', async () => {
  const a = make();
  const base = await listen(a);
  const res = await post(a, '/api/tx', req);
  expect(res.statusCode).toBe(202);
  const { runId } = res.json();
  const events = await readSse(base, `/api/tx/${runId}/events`);
  expect(events.filter((e) => e.event === 'step').map((e) => e.data.index)).toEqual([0, 1, 2, 3]);
  const result = events.find((e) => e.event === 'result')!.data;
  expect(result.txHash).toBe('0x' + 'ab'.repeat(32));
  expect(result.block).toBe(42);
  expect(result.steps).toHaveLength(4);
  expect(result.lenses.map((l: any) => l.party)).toEqual(['BI', 'A', 'B', 'C']);
  // a late subscriber gets the same events replayed
  expect(await readSse(base, `/api/tx/${runId}/events`)).toEqual(events);
});

test('unknown run id is 404', async () => {
  const res = await make().inject('/api/tx/nope/events');
  expect(res.statusCode).toBe(404);
  expect(res.json().reason).toBeTruthy();
});

test('tx failure is delivered as an error event and frees the lock', async () => {
  const z = fakeAdapter('zeto');
  z.run = async () => { throw new Error('rpc putus'); };
  const a = make({ zeto: z });
  const base = await listen(a);
  const { runId } = (await post(a, '/api/tx', req)).json();
  expect(await readSse(base, `/api/tx/${runId}/events`)).toEqual([{ event: 'error', data: { reason: 'rpc putus' } }]);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('rejects a second run while one is active', async () => {
  const z = fakeAdapter('zeto');
  const release = gated(z);
  const a = make({ zeto: z });
  const base = await listen(a);
  const first = await post(a, '/api/tx', req);
  expect(first.statusCode).toBe(202);
  const second = await post(a, '/api/tx', req);
  expect(second.statusCode).toBe(409);
  expect(second.json()).toEqual({ reason: 'Transaksi lain sedang diproses' });
  release();
  await readSse(base, `/api/tx/${first.json().runId}/events`);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('rejects stress while tx active', async () => {
  const z = fakeAdapter('zeto');
  const release = gated(z);
  const a = make({ zeto: z });
  const base = await listen(a);
  const { runId } = (await post(a, '/api/tx', req)).json();
  const res = await post(a, '/api/stress', { models: ['zeto'], count: 5, concurrency: 1, limitS: 120 });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ reason: 'Transaksi lain sedang diproses' });
  release();
  await readSse(base, `/api/tx/${runId}/events`);
});

test('rejects tx while stress active', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { tps: 20 }) });
  expect((await post(a, '/api/stress', { models: ['zeto'], count: 10, concurrency: 1, limitS: 120 })).statusCode).toBe(202);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(409);
  await stressState(a);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('stress: 404 before any run', async () => {
  const a = make();
  expect((await a.inject('/api/stress')).statusCode).toBe(404);
  expect((await a.inject('/api/stress')).json()).toEqual({ reason: 'Belum ada stress test' });
  expect((await a.inject('/api/stress/csv')).statusCode).toBe(404);
  expect((await post(a, '/api/stress/stop', {})).statusCode).toBe(404);
});

test('stress: 400 on schema, capacity and empty model list; 503 on missing adapter', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { capacity: 10 }) });
  const cfg = { models: ['zeto'], count: 5, concurrency: 1, limitS: 120 };
  expect((await post(a, '/api/stress', { ...cfg, concurrency: 3 })).json().reason).toMatch(/^Permintaan tidak valid: /);
  expect((await post(a, '/api/stress', { ...cfg, models: [] })).json()).toEqual({ reason: 'Pilih minimal satu model' });
  const over = await post(a, '/api/stress', { ...cfg, count: 11 });
  expect(over.statusCode).toBe(400);
  expect(over.json()).toEqual({ reason: 'Melebihi kapasitas siap Zeto (10 tx)' });
  const missing = await post(a, '/api/stress', { ...cfg, models: ['noto'] });
  expect(missing.statusCode).toBe(503);
  expect(missing.json()).toEqual({ reason: 'Noto belum tersedia' });
  // failed validation must not leave the lock held
  expect((await post(a, '/api/stress', cfg)).statusCode).toBe(202);
  await stressState(a);
});

test('stress snapshot survives subscriber disconnect', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { tps: 20 }) });
  const base = await listen(a);
  expect((await post(a, '/api/stress', { models: ['zeto'], count: 20, concurrency: 1, limitS: 120 })).statusCode).toBe(202);
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/stress/events`, { signal: ctl.signal });
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  await res.body!.getReader().read(); // first frame arrives
  ctl.abort();
  expect((await a.inject('/api/stress')).json().state).toBe('running');
  const done = await stressState(a);  expect(done.state).toBe('done');
  expect(done.models.zeto.summary.ok).toBe(20);
});

test('stress events end with a done snapshot', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { tps: 50 }) });
  const base = await listen(a);
  await post(a, '/api/stress', { models: ['zeto'], count: 5, concurrency: 1, limitS: 120 });
  const events = await readSse(base, '/api/stress/events');
  expect(events.at(-1)!.event).toBe('done');
  expect(events.at(-1)!.data.state).toBe('done');
  // subscribing after the run is over still yields the final snapshot
  expect((await readSse(base, '/api/stress/events')).at(-1)!.event).toBe('done');
});

test('stress stop ends the run as stopped', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { tps: 10 }) });
  await post(a, '/api/stress', { models: ['zeto'], count: 500, concurrency: 1, limitS: 120 });
  const res = await post(a, '/api/stress/stop', {});
  expect(res.statusCode).toBe(200);
  expect((await stressState(a)).state).toBe('stopped');
});

test('stress csv lists only models that ran', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { tps: 100 }), noto: fakeAdapter('noto', { ready: false }) });
  await post(a, '/api/stress', { models: ['zeto', 'noto'], count: 5, concurrency: 1, limitS: 120 });
  await stressState(a);
  const res = await a.inject('/api/stress/csv');
  expect(res.headers['content-type']).toMatch(/^text\/csv/);
  const lines = res.body.split('\n');
  expect(lines[0]).toBe('model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s');
  expect(lines).toHaveLength(2);
  expect(lines[1].startsWith('Zeto,')).toBe(true);
});

test('serves the web build only when webDist is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lensa-web-'));
  writeFileSync(join(dir, 'index.html'), '<h1>Lensa</h1>');
  expect((await make({}, { webDist: dir }).inject('/')).body).toBe('<h1>Lensa</h1>');
  await app!.close();
  expect((await make({}).inject('/')).statusCode).toBe(404);
});

test('rpcUp is false for a non-JSON body, an error status and a dead port; true for a JSON-RPC result', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/ok') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    else if (req.url === '/err') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }));
    else res.end('<html>not json</html>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    expect(await rpcUp(`${base}/ok`, 'eth_blockNumber')).toBe(true);
    expect(await rpcUp(`${base}/err`, 'eth_blockNumber')).toBe(false);
    expect(await rpcUp(`${base}/html`, 'eth_blockNumber')).toBe(false);
    expect(await rpcUp('http://127.0.0.1:1', 'eth_blockNumber')).toBe(false);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('5xx errors are generic Indonesian and do not leak the message; the lock is released', async () => {
  const z = fakeAdapter('zeto');
  z.capabilities = () => { throw new Error('boom internal'); };
  const a = make({ zeto: z });
  const res = await post(a, '/api/tx', req);
  expect(res.statusCode).toBe(500);
  expect(res.json()).toEqual({ reason: 'Terjadi kesalahan server' });
  z.capabilities = fakeAdapter('zeto').capabilities;
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('preflight-capacity returns ready capacity per available model', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { capacity: 200 }), noto: fakeAdapter('noto', { capacity: 50 }) });
  const res = await a.inject('/api/preflight-capacity');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ zeto: 200, noto: 50 });
});

test('preflight-capacity omits a model whose capacity cannot be read', async () => {
  const z = fakeAdapter('zeto');
  z.loadCapacity = async () => { throw new Error('node mati'); };
  const res = await make({ zeto: z, noto: fakeAdapter('noto', { capacity: 7 }) }).inject('/api/preflight-capacity');
  expect(res.json()).toEqual({ noto: 7 });
});

test('unknown routes are 404 with an Indonesian reason', async () => {
  const res = await make().inject('/api/nope');
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ reason: 'Tidak ditemukan' });
});
