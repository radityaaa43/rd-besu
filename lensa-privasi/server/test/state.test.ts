import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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

test('state dir is 0700 and file 0600, tightening an existing loose tree', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'lensa-')), 'state');
  mkdirSync(dir, { mode: 0o755 });
  writeFileSync(join(dir, 'zeto.json'), '{}', { mode: 0o644 });
  chmodSync(join(dir, 'zeto.json'), 0o644);
  writeState('zeto', { k: 'secret' }, dir);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'zeto.json')).mode & 0o777).toBe(0o600);
});
