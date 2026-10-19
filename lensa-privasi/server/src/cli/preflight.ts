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
  opts: { prepare?: number },
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
    try { check(true, `Kapasitas ${name}: ${await withDeadline(a.loadCapacity(), HEALTH_MS, 'Cek kapasitas')} tx`); }
    catch (e) { check(false, `Kapasitas ${name}`, msg(e)); }
  };
  for (const m of Object.keys(MODEL_NAMES) as ModelId[]) {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--prepare');
  const prepare = i < 0 ? undefined : Number(process.argv[i + 1]);
  if (i >= 0 && !(Number.isInteger(prepare) && prepare! > 0)) {
    console.error('Pemakaian: npm run preflight [-- --prepare N]');
    process.exit(1);
  }
  process.exit(await runPreflight(await loadAdapters(), probeNodes, { prepare }, console.log));
}
