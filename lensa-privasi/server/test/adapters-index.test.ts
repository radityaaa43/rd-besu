import { expect, test } from 'vitest';
import { loadAdapters } from '../src/adapters/index.ts';

test('no adapters selected gives {} regardless of state files on disk', async () => expect(await loadAdapters({ only: [] })).toEqual({}));

test('a model whose module does not exist is skipped', async () =>
  expect(await loadAdapters({ only: ['nonexistent' as any] })).toEqual({}));
