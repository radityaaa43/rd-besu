import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readState, writeState } from '../src/state.ts';

test('bigint round-trip', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'lensa-')), 'nested');
  const v = { a: 1n, b: [2n], c: 'x' };
  writeState('zeto', v, dir);
  expect(readState('zeto', dir)).toEqual(v);
});
test('missing file gives null', () => expect(readState('noto', mkdtempSync(join(tmpdir(), 'lensa-')))).toBeNull());
