import { expect, it } from 'vitest';
import { LOOKUP, ledgerParties } from '../src/adapters/zeto.ts';

// A stand-in for BI's verified ledger: owner keys map to identities like BiLedger.ownerOf does.
const keys: Record<string, string> = { kA: LOOKUP.A, kB: LOOKUP.B, kBI: LOOKUP.BI };
const ledger = (rows: Record<string, { owner: string; reporters: string[] }>) => ({
  verified: new Map(Object.entries(rows).map(([c, r]) => [c, { output: { owner: r.owner }, reporters: new Set(r.reporters) }])),
  ownerOf: (k: string) => keys[k] ?? k,
});

it('transfer: reporter is the sender, the other output owner is the receiver (change ignored)', () => {
  const l = ledger({ r: { owner: 'kB', reporters: [LOOKUP.A] }, change: { owner: 'kA', reporters: [LOOKUP.A] } });
  expect(ledgerParties(l, ['r', 'change'], false)).toEqual({ from: 'A', to: 'B' });
});

it('issue: from is BI, to is the owner of the minted output', () => {
  const l = ledger({ m: { owner: 'kB', reporters: [LOOKUP.B] } });
  expect(ledgerParties(l, ['m'], true)).toEqual({ from: 'BI', to: 'B' });
});

it('nothing verified: null', () => {
  expect(ledgerParties(ledger({}), ['x'], false)).toBeNull();
});

it('ambiguous reporters or owners give null sides, unknown keys are not invented', () => {
  const l = ledger({ a: { owner: 'kB', reporters: [LOOKUP.A, LOOKUP.B] }, b: { owner: 'zz', reporters: [LOOKUP.A, LOOKUP.B] } });
  expect(ledgerParties(l, ['a', 'b'], false)).toBeNull();
});
