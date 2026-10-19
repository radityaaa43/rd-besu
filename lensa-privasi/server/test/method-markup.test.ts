import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// LensView.method is plain text: function names are marked with backticks, and the web renders them as code elements.
test.each(['zeto', 'noto', 'stealth'])('%s adapter writes no HTML tags in method text', (name) => {
  const src = readFileSync(new URL(`../src/adapters/${name}.ts`, import.meta.url), 'utf8');
  expect(src).not.toMatch(/<\/?code>/);
});
