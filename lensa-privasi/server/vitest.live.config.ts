import { defineConfig } from 'vitest/config';

// Live tests hit the real Besu/Paladin cluster; run one file at a time: npm run test:live -- test/live/<model>.live.ts
export default defineConfig({ test: { include: ['test/live/**/*.live.ts'], testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false } });
