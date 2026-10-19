import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Capability, LensView, ModelAdapter } from './adapter.ts';
import { withDeadline } from './deadline.ts';
import {
  FLOWS, MODEL_NAMES, PARTIES, PRICE_PER_UNIT, validateRequest,
  type FlowId, type FlowRequest, type ModelId, type PartyId,
} from './domain.ts';
import { probeNodes, type Probe } from './health.ts';
import { HEALTH_MS, StressRun, validateStress, type StressConfig } from './stress.ts';
import { toCsv } from './stats.ts';

type Adapters = Partial<Record<ModelId, ModelAdapter>>;

const MODELS = Object.keys(MODEL_NAMES) as ModelId[];
const PARTY_IDS = Object.keys(PARTIES) as PartyId[];
const TX_DEADLINE_MS = 120_000;
const HEALTH_POLL_MS = 3_000; // /api/health is polled by the UI; stress and tx keep the longer HEALTH_MS
const KEEP_RUN_MS = 5 * 60_000;
const BUSY_REASON = 'Transaksi lain sedang diproses';
const NA = 'Belum tersedia';

const txBody = {
  type: 'object', additionalProperties: false,
  required: ['model', 'flow', 'from', 'to', 'amount'],
  properties: {
    model: { enum: MODELS },
    flow: { enum: Object.keys(FLOWS) },
    from: { enum: PARTY_IDS },
    to: { enum: PARTY_IDS },
    amount: { type: 'string' },
  },
} as const;
const stressBody = {
  type: 'object', additionalProperties: false,
  required: ['models', 'count', 'concurrency', 'limitS'],
  properties: {
    models: { type: 'array', uniqueItems: true, items: { enum: MODELS } },
    count: { type: 'integer' },
    concurrency: { enum: [1, 2, 4, 8] },
    limitS: { enum: [120, 300, 600] },
  },
} as const;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Sse { send(event: string, data: unknown): void; end(): void }

export function buildApp(adapters: Adapters, opts: { webDist?: string; probe?: Probe } = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.VITEST ? 'silent' : 'error' }, // real errors reach the console; tests stay quiet
    forceCloseConnections: true, // shutdown must not wait on keep-alive / SSE sockets
    // strict bodies: no coercion (amount must be a string, count an integer) and no silent stripping of unknown keys
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const probe = opts.probe ?? probeNodes;

  // ponytail: one process-wide lock; only one tx or stress run at a time by design
  let busy: 'tx' | 'stress' | null = null;
  let lastStress: StressRun | null = null;
  const streams = new Set<ServerResponse>();
  app.addHook('onClose', async () => { for (const r of streams) r.end(); });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ reason: 'Tidak ditemukan' }));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) {
      const v = err.validation[0];
      const p = v.params as { missingProperty?: string; additionalProperty?: string };
      const field = p.missingProperty ?? p.additionalProperty ?? (v.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'body');
      return reply.code(400).send({ reason: `Permintaan tidak valid: ${field}` });
    }
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (code >= 500) req.log.error(err);
    reply.code(code).send({ reason: code < 500 ? 'Permintaan tidak valid' : 'Terjadi kesalahan server' });
  });

  function openSse(req: FastifyRequest, reply: FastifyReply, onClose: () => void): Sse {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const write = (s: string) => { try { raw.write(s); } catch { /* client gone */ } };
    write(':ok\n\n');
    streams.add(raw);
    const beat = setInterval(() => write(':ok\n\n'), 15_000);
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; clearInterval(beat); streams.delete(raw); onClose(); };
    req.raw.on('close', cleanup);
    raw.on('close', cleanup);
    raw.on('error', () => { /* write to a gone client; close handler cleans up */ });
    return {
      send: (event, data) => write(`event: ${event}\ndata: ${json(data)}\n\n`),
      end: () => { clearInterval(beat); try { raw.end(); } catch { /* already closed */ } },
    };
  }

  const modelUnavailable = (m: ModelId) => ({ reason: `${MODEL_NAMES[m]} belum tersedia` });

  app.get('/api/meta', async () => {
    const unavailable = Object.fromEntries(
      (Object.keys(FLOWS) as FlowId[]).map((f): [FlowId, Capability] => [f, { enabled: false, reason: NA }]),
    ) as Record<FlowId, Capability>;
    return {
      parties: PARTIES, flows: FLOWS,
      models: Object.fromEntries(MODELS.map((m) => {
        const a = adapters[m];
        return [m, { name: MODEL_NAMES[m], available: !!a, stepLabels: a?.stepLabels ?? [], capabilities: a ? a.capabilities() : unavailable }];
      })),
    };
  });

  app.get('/api/health', async () => {
    const [nodes, ...health] = await Promise.all([
      probe().catch(() => ({ besu: false, paladin: [false, false, false, false] })),
      ...MODELS.map((m) => {
        const a = adapters[m];
        if (!a) return { ready: false, detail: NA };
        return withDeadline(a.health(), HEALTH_POLL_MS, 'Cek kesiapan').catch((e) => ({ ready: false, detail: msg(e) }));
      }),
    ]);
    return { models: Object.fromEntries(MODELS.map((m, i) => [m, health[i]])), nodes };
  });

  // ---- single transactions ----
  interface TxRun { events: { name: string; data: unknown }[]; subs: Set<Sse>; done: boolean }
  const runs = new Map<string, TxRun>();

  async function execute(run: TxRun, adapter: ModelAdapter, req: FlowRequest, amount: bigint) {
    let closed = false;
    const emit = (name: string, data: unknown) => {
      if (closed && name === 'step') return; // late step after a deadline
      run.events.push({ name, data });
      for (const s of run.subs) s.send(name, data);
    };
    try {
      const out = await withDeadline((async () => {
        const result = await adapter.run(req, amount, (s) => emit('step', s));
        const lenses: LensView[] = await Promise.all(PARTY_IDS.map((p) => adapter.lens(req, result, p)));
        return { txHash: result.txHash, block: result.block, steps: result.steps, lenses };
      })(), TX_DEADLINE_MS, 'Transaksi');
      emit('result', out);
    } catch (e) {
      emit('error', { reason: msg(e) });
    } finally {
      closed = true;
      run.done = true;
      busy = null;
      for (const s of run.subs) s.end();
    }
  }

  app.post<{ Body: FlowRequest }>('/api/tx', { schema: { body: txBody } }, async (request, reply) => {
    const body = request.body;
    const v = validateRequest(body);
    if (!v.ok) return reply.code(400).send({ reason: v.reason });
    const adapter = adapters[body.model];
    if (!adapter) return reply.code(503).send(modelUnavailable(body.model));
    if (busy) return reply.code(409).send({ reason: BUSY_REASON });

    busy = 'tx'; // taken synchronously, before any await
    let started = false;
    try {
      const cap = adapter.capabilities()[body.flow];
      if (!cap.enabled) return reply.code(409).send({ reason: `Alur ini tidak tersedia: ${cap.reason}` });
      try {
        const h = await withDeadline(adapter.health(), HEALTH_MS, 'Cek kesiapan');
        if (!h.ready) return reply.code(503).send({ reason: `${MODEL_NAMES[body.model]} belum siap: ${h.detail}` });
      } catch (e) {
        return reply.code(503).send({ reason: `${MODEL_NAMES[body.model]} belum siap: ${msg(e)}` });
      }

      // [who pays, asset, needed]; issuing needs no balance, dvp checks both legs
      const flow = FLOWS[body.flow];
      const needs: [PartyId, 'RD' | 'DFABI', bigint][] = flow.issuer ? []
        : flow.dvp ? [[body.from, 'DFABI', v.amount], [body.to, 'RD', v.amount * PRICE_PER_UNIT]]
          : [[body.from, flow.asset, v.amount]];
      try {
        for (const [party, asset, need] of needs) {
          if (await withDeadline(adapter.balanceOf(party, asset), HEALTH_MS, 'Cek saldo') < need) {
            return reply.code(400).send({ reason: `Saldo ${PARTIES[party].name} tidak cukup` });
          }
        }
      } catch (e) {
        return reply.code(503).send({ reason: `${MODEL_NAMES[body.model]} belum siap: ${msg(e)}` });
      }

      const runId = randomUUID();
      const run: TxRun = { events: [], subs: new Set(), done: false };
      runs.set(runId, run);
      started = true;
      void execute(run, adapter, body, v.amount).finally(() => {
        setTimeout(() => runs.delete(runId), KEEP_RUN_MS).unref();
      });
      return reply.code(202).send({ runId });
    } finally {
      if (!started) busy = null;
    }
  });

  app.get<{ Params: { runId: string } }>('/api/tx/:runId/events', async (request, reply) => {
    const run = runs.get(request.params.runId);
    if (!run) return reply.code(404).send({ reason: 'Transaksi tidak ditemukan' });
    const sse: Sse = openSse(request, reply, () => run.subs.delete(sse));
    for (const e of run.events) sse.send(e.name, e.data);
    if (run.done) sse.end(); else run.subs.add(sse);
    return reply;
  });

  // ready transaction capacity per model; a model that is missing or cannot answer is left out
  app.get('/api/preflight-capacity', async () => {
    const entries = await Promise.all(MODELS.map(async (m): Promise<[ModelId, number][]> => {
      const a = adapters[m];
      if (!a) return [];
      try { return [[m, await withDeadline(a.loadCapacity(), HEALTH_MS, 'Cek kapasitas')]]; } catch { return []; }
    }));
    return Object.fromEntries(entries.flat());
  });

  // ---- stress ----
  app.post<{ Body: StressConfig }>('/api/stress', { schema: { body: stressBody } }, async (request, reply) => {
    const cfg = request.body;
    for (const m of cfg.models) if (!adapters[m]) return reply.code(503).send(modelUnavailable(m));
    if (busy) return reply.code(409).send({ reason: BUSY_REASON });

    busy = 'stress';
    let started = false;
    try {
      const capacity: Partial<Record<ModelId, number>> = {};
      for (const m of cfg.models) {
        try { capacity[m] = await withDeadline(adapters[m]!.loadCapacity(), HEALTH_MS, 'Cek kapasitas'); }
        catch (e) { return reply.code(503).send({ reason: `${MODEL_NAMES[m]} belum siap: ${msg(e)}` }); }
      }
      const v = validateStress(cfg, capacity);
      if (!v.ok) return reply.code(400).send({ reason: v.reason });

      const run = new StressRun(cfg, adapters);
      lastStress = run;
      started = true;
      run.start().catch(() => { /* surfaced through the snapshot */ }).finally(() => { busy = null; });
      return reply.code(202).send(run.snapshot());
    } finally {
      if (!started) busy = null;
    }
  });

  const noStress = (reply: FastifyReply) => reply.code(404).send({ reason: 'Belum ada stress test' });

  app.get('/api/stress', async (_req, reply) => (lastStress ? lastStress.snapshot() : noStress(reply)));

  app.get('/api/stress/events', async (request, reply) => {
    const run = lastStress;
    if (!run) return noStress(reply);
    const snap = run.snapshot();
    const onTick = (s: unknown) => sse.send('tick', s);
    const onDone = (s: unknown) => { sse.send('done', s); sse.end(); };
    const sse: Sse = openSse(request, reply, () => { run.off('tick', onTick); run.off('done', onDone); });
    if (snap.state !== 'running') { sse.send('done', snap); sse.end(); return reply; }
    sse.send('tick', snap);
    run.on('tick', onTick);
    run.on('done', onDone);
    return reply;
  });

  app.post('/api/stress/stop', async (_req, reply) => {
    if (!lastStress) return noStress(reply);
    lastStress.stop();
    return lastStress.snapshot();
  });

  app.get('/api/stress/csv', async (_req, reply) => {
    if (!lastStress) return noStress(reply);
    const snap = lastStress.snapshot();
    const rows = MODELS.flatMap((m) => {
      const s = snap.models[m];
      return s && s.status !== 'waiting' && s.status !== 'skipped' ? [{ model: MODEL_NAMES[m], s: s.summary }] : [];
    });
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="lensa-stress.csv"').send(toCsv(rows));
  });

  if (opts.webDist) app.register(fastifyStatic, { root: opts.webDist });

  return app;
}
