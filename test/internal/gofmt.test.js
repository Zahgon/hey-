// Every expectation here is a value RECORDED from go1.26.7, not a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatF, formatNumber, formatNumber3, formatNumberInt } from '../../src/internal/gofmt.js';

test('formatNumber matches Go %4.4f', () => {
  // label -> recorded `fmt.Sprintf("%4.4f", v)`
  const recorded = [
    [0, '0.0000'],
    [1, '1.0000'],
    [5e-5, '0.0001'],
    [1234.56789, '1234.5679'],
    [-1.5, '-1.5000'],
    [1e21, '1000000000000000000000.0000'],
    [0.5, '0.5000'],
    [1.5, '1.5000'],
    [2.5, '2.5000'],
    [0.12345, '0.1235'],
    [1e-7, '0.0000'],
    [0.00015, '0.0001'],
    [0.00025, '0.0003'],
    [0.00035, '0.0003'],
    [1.0005, '1.0005'],
    [2.0005, '2.0005'],
    [1234.56785, '1234.5678'],
    [0.0625, '0.0625'],
    [1e20, '100000000000000000000.0000'],
    [123456789012345678901.0, '123456789012345683968.0000'],
  ];
  for (const [input, want] of recorded) {
    assert.equal(formatNumber(input), want, `%4.4f of ${input}`);
  }
});

test('formatNumber3 matches Go %4.3f', () => {
  const recorded = [
    [0.0001234, '0.000'],
    [12.3456, '12.346'],
    [0.5, '0.500'],
    [2.5, '2.500'],
    [2.0005, '2.001'],
    [1.0005, '1.000'],
    [1234.56785, '1234.568'],
    [1e21, '1000000000000000000000.000'],
  ];
  for (const [input, want] of recorded) {
    assert.equal(formatNumber3(input), want, `%4.3f of ${input}`);
  }
});

test('G-FMT-1 ties round to even, unlike toFixed', () => {
  // 0.0625 is exactly representable, so this is a true tie.
  assert.equal(formatNumber3(0.0625), '0.062');
  assert.equal((0.0625).toFixed(3), '0.063', 'toFixed still disagrees — the point of the port');
});

test('G-FMT-2 no exponent cliff at 1e21', () => {
  assert.equal(formatNumber(1e21), '1000000000000000000000.0000');
  assert.equal((1e21).toFixed(4), '1e+21', 'toFixed still diverges');
});

test('G-FMT-3 non-finite values keep the width but drop the precision', () => {
  assert.equal(formatNumber(NaN), ' NaN');
  assert.equal(formatNumber(Infinity), '+Inf');
  assert.equal(formatNumber(-Infinity), '-Inf');
  assert.equal(formatNumber3(NaN), ' NaN');
  // Width 4 is a minimum, so a 3-char body gains exactly one pad space.
  assert.equal(formatF(NaN, 4, 4).length, 4);
});

test('negative zero keeps its sign, as in Go', () => {
  assert.equal(formatNumber(-0), '-0.0000');
});

test('formatNumberInt matches Go %d', () => {
  assert.equal(formatNumberInt(0), '0');
  assert.equal(formatNumberInt(200), '200');
  assert.equal(formatNumberInt(-5), '-5');
  assert.equal(formatNumberInt(10n), '10');
  assert.throws(() => formatNumberInt(1.5), TypeError);
});
