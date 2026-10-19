import { isMissing } from '../adapters/index.ts';

const model = process.argv[2];
if (model !== 'stealth' && model !== 'noto' && model !== 'zeto') {
  console.error(`Model tidak dikenal: ${model}. Pilih: stealth, noto, zeto`);
  process.exit(1);
}
let mod: { bootstrap(): Promise<void> };
try {
  mod = await import(`./bootstrap-${model}.ts`);
} catch (e) {
  if (!isMissing(e, `bootstrap-${model}.ts`)) throw e;
  console.error(`Bootstrap ${model} belum tersedia`);
  process.exit(1);
}
await mod.bootstrap();
