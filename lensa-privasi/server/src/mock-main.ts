// Demo/Playwright server: the real HTTP API over fake adapters, no chain access. Run: PORT=8791 npx tsx src/mock-main.ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { fakeAdapter } from '../test/fake-adapter.ts';

const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = buildApp(
  {
    zeto: fakeAdapter('zeto', { tps: 1.5, capacity: 500 }),
    noto: fakeAdapter('noto', { tps: 3, capacity: 500 }),
    stealth: fakeAdapter('stealth', { tps: 8, capacity: 500 }),
  },
  { webDist: existsSync(dist) ? dist : undefined, probe: async () => ({ besu: true, paladin: [true, true, true, true] }) },
);
const port = Number(process.env.PORT ?? 8791);
await app.listen({ host: '127.0.0.1', port });
console.log(`Lensa Privasi (mock): http://127.0.0.1:${port}`);
