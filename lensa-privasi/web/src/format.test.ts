import { expect, test } from 'vitest';
import { amountWords, formatDecimal, formatRupiah, formatSeconds, formatUnits, parseAmountInput, shortHash, splitCode } from './format.ts';

test('splitCode turns backtick spans into code segments', () => {
  expect(splitCode('Baca (`ptx.getStateReceipt`, `scanChain`).')).toEqual([
    { text: 'Baca (', code: false }, { text: 'ptx.getStateReceipt', code: true }, { text: ', ', code: false },
    { text: 'scanChain', code: true }, { text: ').', code: false },
  ]);
  expect(splitCode('polos')).toEqual([{ text: 'polos', code: false }]);
  expect(splitCode('')).toEqual([]);
});
test('splitCode never interprets HTML', () => {
  expect(splitCode('<b>x</b>')).toEqual([{ text: '<b>x</b>', code: false }]);
});

test('formatRupiah groups with dots', () => {
  expect(formatRupiah(1_000_000_000n)).toBe('Rp 1.000.000.000');
});

test('formatUnits', () => {
  expect(formatUnits(1000n)).toBe('1.000 unit DFABI');
});

test('amountWords for RD', () => {
  expect(amountWords(1_000_000_000n, 'RD')).toBe('1 miliar rupiah');
  expect(amountWords(1_500_000_000_000n, 'RD')).toBe('1,5 triliun rupiah');
  expect(amountWords(250_000_000n, 'RD')).toBe('250 juta rupiah');
  expect(amountWords(500n, 'RD')).toBe('500 rupiah');
});

test('amountWords for DFABI', () => {
  expect(amountWords(1000n, 'DFABI')).toBe('1.000 unit');
});

test('parseAmountInput strips everything but digits', () => {
  expect(parseAmountInput('1.000.000')).toBe(1000000n);
  expect(parseAmountInput('Rp 25')).toBe(25n);
  expect(parseAmountInput('')).toBeNull();
  expect(parseAmountInput('abc')).toBeNull();
});

test('parseAmountInput keeps precision above 2^53', () => {
  expect(parseAmountInput('9007199254740993')).toBe(9007199254740993n);
});

test('formatDecimal uses id-ID with fixed digits', () => {
  expect(formatDecimal(8)).toBe('8,0');
  expect(formatDecimal(1234.56, 2)).toBe('1.234,56');
});

test('formatSeconds shows milliseconds as seconds', () => {
  expect(formatSeconds(2140)).toBe('2,14 s');
});

test('shortHash keeps long hex readable and short values intact', () => {
  expect(shortHash('0x' + 'ab'.repeat(32))).toBe('0xabababab…abab');
  expect(shortHash('0x12')).toBe('0x12');
});
