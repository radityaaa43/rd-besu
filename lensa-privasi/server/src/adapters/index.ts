import type { ModelAdapter } from '../adapter.ts';
import type { ModelId } from '../domain.ts';

// Each adapter module (stealth.ts, noto.ts, zeto.ts) exports load(); null when its state file is missing.
export async function loadAdapters(): Promise<Partial<Record<ModelId, ModelAdapter>>> {
  const out: Partial<Record<ModelId, ModelAdapter>> = {};
  for (const m of ['stealth', 'noto', 'zeto'] as const) {
    try {
      const a = await ((await import(`./${m}.ts`)) as { load(): Promise<ModelAdapter | null> }).load();
      if (a) out[m] = a;
    } catch (e) {
      if (!isMissing(e, `${m}.ts`)) throw e;
    }
  }
  return out;
}

// "Not built yet" = the module file itself is absent, not one of its own imports.
export function isMissing(e: unknown, file: string): boolean {
  const err = e as { code?: string; message?: string };
  const msg = err.message ?? '';
  const f = file.replace('.', '\\.');
  return (err.code === 'ERR_MODULE_NOT_FOUND' && new RegExp(`Cannot find module '[^']*[\\\\/]${f}'`).test(msg))
    || new RegExp(`Failed to load url \\./${f}\\b`).test(msg);
}
