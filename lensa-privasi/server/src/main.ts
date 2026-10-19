import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAdapters } from './adapters/index.ts';
import { buildApp } from './app.ts';

const PORT = 8787;
const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = buildApp(await loadAdapters(), { webDist: existsSync(dist) ? dist : undefined });
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`Lensa Privasi: http://127.0.0.1:${PORT}`);
console.log(`Dari laptop: ssh -L ${PORT}:localhost:${PORT} <host>`);
