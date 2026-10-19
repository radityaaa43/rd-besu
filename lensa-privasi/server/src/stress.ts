import { EventEmitter } from 'node:events';
import { CANCELLED, LOAD_AMOUNT, type ModelAdapter } from './adapter.ts';
import { MODEL_NAMES, type BankId, type ModelId } from './domain.ts';
import { withDeadline } from './deadline.ts';
import { summarize, type Sample, type Summary } from './stats.ts';

export interface StressConfig { models: ModelId[]; count: number; concurrency: 1 | 2 | 4 | 8; limitS: 120 | 300 | 600 }
export type ModelRunStatus = 'waiting' | 'running' | 'done' | 'stopped' | 'timeout' | 'skipped';
export interface ModelSnapshot { status: ModelRunStatus; reason?: string; firstError?: string; elapsedS: number; summary: Summary }
export interface StressSnapshot {
  state: 'running' | 'done' | 'stopped'; config: StressConfig;
  models: Partial<Record<ModelId, ModelSnapshot>>;
}

const PAIRS: [BankId, BankId][] = [['A', 'B'], ['B', 'C'], ['C', 'A']];
// Each adapter applies the real per-transaction deadline (120 s) from lock acquisition; this only stops a lost promise from hanging the run.
const OUTER_GUARD_MS = 600_000;
const DRAIN_MS = 30_000;
export const HEALTH_MS = 10_000;

export function validateStress(c: StressConfig, capacity: Partial<Record<ModelId, number>>): { ok: true } | { ok: false; reason: string } {
  if (c.models.length === 0) return { ok: false, reason: 'Pilih minimal satu model' };
  if (!(Number.isInteger(c.count) && c.count >= 1)) return { ok: false, reason: 'Jumlah transaksi minimal 1' };
  for (const m of c.models) {
    // a model absent from the capacity map has no adapter loaded
    if (capacity[m] === undefined) return { ok: false, reason: `${MODEL_NAMES[m]} belum tersedia` };
    if (c.count > (capacity[m] ?? 0)) return { ok: false, reason: `Melebihi kapasitas siap ${MODEL_NAMES[m]} (${capacity[m]} tx)` };
  }
  return { ok: true };
}

interface ModelState {
  status: ModelRunStatus; reason?: string; firstError?: string;
  startedAt?: number; endedAt?: number; samples: Sample[]; failed: number;
}

export class StressRun extends EventEmitter {
  private states: Partial<Record<ModelId, ModelState>> = {};
  private state: StressSnapshot['state'] = 'running';
  private stopped = false;
  private signal?: { aborted: boolean }; // the running model's abort flag
  private stopSignal!: () => void;
  private stopP = new Promise<void>((r) => { this.stopSignal = r; });
  private lastTick = -Infinity;

  constructor(
    private cfg: StressConfig,
    private adapters: Partial<Record<ModelId, ModelAdapter>>,
    private clock: { now(): number } = { now: () => Date.now() },
  ) {
    super();
    for (const m of cfg.models) this.states[m] = { status: 'waiting', samples: [], failed: 0 };
  }

  stop(): void { this.stopped = true; if (this.signal) this.signal.aborted = true; this.stopSignal(); }

  snapshot(): StressSnapshot {
    const models: StressSnapshot['models'] = {};
    for (const m of this.cfg.models) {
      const s = this.states[m]!;
      const end = s.endedAt ?? this.clock.now();
      models[m] = {
        status: s.status, reason: s.reason, firstError: s.firstError,
        elapsedS: s.startedAt === undefined ? 0 : Math.floor((end - s.startedAt) / 1000),
        summary: summarize(s.samples, s.failed),
      };
    }
    return { state: this.state, config: this.cfg, models };
  }

  async start(): Promise<StressSnapshot> {
    try {
      for (const m of this.cfg.models) {
        if (this.stopped) break;
        await this.runModel(m);
      }
    } finally {
      this.state = this.stopped ? 'stopped' : 'done';
      this.emit('done', this.snapshot());
    }
    return this.snapshot();
  }

  private tick(): void {
    const now = this.clock.now();
    if (now - this.lastTick < 1000) return;
    this.lastTick = now;
    this.emit('tick', this.snapshot());
  }

  private async runModel(m: ModelId): Promise<void> {
    const st = this.states[m]!;
    const adapter = this.adapters[m];
    if (!adapter) { st.status = 'skipped'; st.reason = `${MODEL_NAMES[m]} belum tersedia`; return; }
    try {
      const health = await withDeadline(adapter.health(), HEALTH_MS, 'Cek kesiapan');
      if (!health.ready) { st.status = 'skipped'; st.reason = health.detail; return; }
    } catch (e) {
      st.status = 'skipped'; st.reason = e instanceof Error ? e.message : String(e); return;
    }

    st.status = 'running';
    st.startedAt = this.clock.now();
    const { count, concurrency, limitS } = this.cfg;
    let started = 0, inflight = 0, timedOut = false, closed = false;
    // Set on stop, on the time limit and when the run closes: calls still queued behind an adapter lock then never submit.
    const signal = this.signal = { aborted: this.stopped };

    const worker = async () => {
      for (;;) {
        if (this.stopped || started >= count) return;
        if (this.clock.now() - st.startedAt! >= limitS * 1000) { timedOut = true; signal.aborted = true; return; }
        inflight++;
        const [from, to] = PAIRS[started++ % 3]; // by claimed slot, so the pairs stay balanced for any worker count
        try {
          const sample = await withDeadline(adapter.transferForLoad(from, to, LOAD_AMOUNT, signal), OUTER_GUARD_MS, 'Transaksi');
          if (!closed) st.samples.push(sample);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!closed && msg !== CANCELLED) { st.failed++; st.firstError ??= msg; }
        } finally { inflight--; }
        if (!closed) this.tick();
      }
    };

    const all = Promise.all(Array.from({ length: concurrency }, () => worker()));
    // after stop(), wait for in-flight calls at most DRAIN_MS
    const drain = this.stopP.then(() => withDeadline(all, DRAIN_MS, 'Penghentian')).then(() => {}, () => { /* gave up waiting */ });
    await Promise.race([all, drain]);

    closed = true;
    signal.aborted = true;
    if (inflight > 0) { st.failed += inflight; st.firstError ??= 'Dihentikan sebelum selesai'; }
    st.endedAt = this.clock.now();
    st.status = this.stopped ? 'stopped' : timedOut ? 'timeout' : 'done';
  }
}
