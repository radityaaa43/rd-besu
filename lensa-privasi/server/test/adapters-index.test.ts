import { expect, test } from 'vitest';
import { loadAdapters } from '../src/adapters/index.ts';

test('no adapter modules present gives {}', async () => expect(await loadAdapters()).toEqual({}));
