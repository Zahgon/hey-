// Expectations recorded from go1.26.7 (PHASE 2 probe transcript, section B).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareStringsUTF8,
  sortStrings,
  sortFloat64s,
  templateMapKeys,
} from '../../src/internal/gosort.js';

test('G-SORT-2 integer map keys range in numeric order', () => {
  const m = new Map([[500, 1], [200, 7], [404, 3], [100, 2], [-5, 1]]);
  assert.deepEqual(templateMapKeys(m), [-5, 100, 200, 404, 500]);
});

test('G-SORT-2 string map keys range in UTF-8 byte order', () => {
  const m = new Map([['zeta', 1], ['alpha', 2], ['Beta', 3], ['', 9]]);
  // Recorded Go output was: [9] [3]Beta [2]alpha [1]zeta
  assert.deepEqual(templateMapKeys(m), ['', 'Beta', 'alpha', 'zeta']);
});

test('G-SORT-3 UTF-8 order differs from JS default string order', () => {
  const input = ['a', '\uff01', '\u{10000}'];
  assert.deepEqual(sortStrings([...input]), ['a', '\uff01', '\u{10000}']);
  // The default JS comparator sorts by UTF-16 code units and disagrees.
  assert.deepEqual([...input].sort(), ['a', '\u{10000}', '\uff01']);
});

test('compareStringsUTF8 handles prefixes and equality', () => {
  assert.equal(compareStringsUTF8('ab', 'abc'), -1);
  assert.equal(compareStringsUTF8('abc', 'ab'), 1);
  assert.equal(compareStringsUTF8('abc', 'abc'), 0);
  assert.equal(compareStringsUTF8('', 'a'), -1);
});

test('G-SORT-1 sort.Float64s puts NaN first', () => {
  const got = sortFloat64s([3, NaN, 1, 2]);
  assert.ok(Number.isNaN(got[0]), 'NaN must sort to index 0');
  assert.deepEqual(got.slice(1), [1, 2, 3]);
});

test('sortFloat64s orders normally without NaN', () => {
  assert.deepEqual(sortFloat64s([0.3, 0.1, 0.2, 0, -1]), [-1, 0, 0.1, 0.2, 0.3]);
});
