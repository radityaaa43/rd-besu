import { fileURLToPath } from 'node:url';
import type { ModelAdapter } from '../adapter.ts';
import { loadAdapters } from '../adapters/index.ts';
import { withDeadline } from '../deadline.ts';
import { MODEL_NAMES, type ModelId } from '../domain.ts';
import { probeNodes, type Probe } from '../health.ts';
import { HEALTH_MS } from '../stress.ts';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Prints one OK/GAGAL line per check; returns the exit code (1 when any check fails).
export async function runPreflight(
  adapters: Partial<Record<ModelId, ModelAdapter>>,
  probe: Probe,
  opts: { prepare?: number; only?: ModelId[] },
  print: (line: string) => void,
): Promise<number> {
  let failed = false;
  const check = (ok: boolean, label: string, reason = '') => {
    if (!ok) failed = true;
    print(ok ? `OK ${label}` : `GAGAL ${label}${reason ? `: ${reason}` : ''}`);
  };
  const nodes = await probe();
  nodes.paladin.forEach((up, i) => check(up, `Paladin node ${i + 1}`, 'tidak menjawab'));
  check(nodes.besu, 'Besu', 'tidak menjawab');

  const capacity = async (a: ModelAdapter, name: string) => {
    try {
      const cap = await withDeadline(a.loadCapacity(), HEALTH_MS, 'Cek kapasitas');
      if (opts.prepare && cap < opts.prepare) check(false, `Kapasitas ${name}`, `${opts.prepare} tx diminta, siap ${cap}`);
      else check(true, `Kapasitas ${name}: ${cap} tx`);
    } catch (e) { check(false, `Kapasitas ${name}`, msg(e)); }
  };
  for (const m of (opts.only ?? Object.keys(MODEL_NAMES)) as ModelId[]) {
    const name = MODEL_NAMES[m];
    const a = adapters[m];
    if (!a) { check(false, `${name} belum tersedia`); continue; }
    try {
      const h = await withDeadline(a.health(), HEALTH_MS, 'Cek kesiapan');
      check(h.ready, name, h.detail);
      if (!h.ready) continue;
    } catch (e) { check(false, name, msg(e)); continue; }
    if (opts.prepare) {
      try { await a.prepareLoad(opts.prepare); } catch (e) { check(false, `Siapkan beban ${name}`, msg(e)); continue; }
    }
    await capacity(a, name);
  }
  return failed ? 1 : 0;
}

const PREPARE_MAX = 10_000;

// undefined when --prepare is absent; otherwise a strict positive integer <= PREPARE_MAX
export function parsePrepare(argv: string[]): number | undefined {
  const i = argv.indexOf('--prepare');
  if (i < 0) return undefined;
  const arg = argv[i + 1] ?? '';
  const n = Number(arg);
  if (!/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(n) || n > PREPARE_MAX) {
    throw new Error(`--prepare butuh bilangan bulat positif (1..${PREPARE_MAX}), dapat: "${arg}"`);
  }
  return n;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let prepare: number | undefined;
  try { prepare = parsePrepare(process.argv); } catch (e) { console.error(msg(e)); process.exit(2); }
  // --only stealth,noto: prepare (and check) just these models, e.g. Stealth is Besu-only and spares the Paladin nodes
  const oi = process.argv.indexOf('--only');
  const only = oi < 0 ? undefined : (process.argv[oi + 1] ?? '').split(',').filter((m): m is ModelId => m in MODEL_NAMES);
  if (only && !only.length) { console.error('--only butuh model: stealth, noto, atau zeto'); process.exit(2); }
  let adapters;
  try { adapters = await loadAdapters({ only }); } catch (e) { console.log(`GAGAL Muat adapter: ${msg(e)}`); process.exit(1); }
  process.exit(await runPreflight(adapters, probeNodes, { prepare, only }, console.log));
}
