// Expectations recorded from go1.26.7 (see PHASE 2 probe transcript, section E).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, seconds, SECOND } from '../../src/internal/goduration.js';

test('parseDuration matches Go for accepted inputs', () => {
  const recorded = [
    ['10s', 10000000000n],
    ['3m', 180000000000n],
    ['0', 0n],
    ['1h30m', 5400000000000n],
    ['100ms', 100000000n],
    ['1.5s', 1500000000n],
    ['-2s', -2000000000n],
    ['2us', 2000n],
    ['1\u00b5s', 1000n],
    ['1\u03bcs', 1000n],
    ['1ns', 1n],
    ['+5s', 5000000000n],
    ['1h0m0s', 3600000000000n],
    ['.5s', 500000000n],
    ['0s', 0n],
    ['-0', 0n],
  ];
  for (const [input, want] of recorded) {
    assert.equal(parseDuration(input), want, `parseDuration(${JSON.stringify(input)})`);
  }
});

test('parseDuration reproduces Go error text exactly', () => {
  const recorded = [
    ['', 'time: invalid duration ""'],
    ['10', 'time: missing unit in duration "10"'],
    ['1d', 'time: unknown unit "d" in duration "1d"'],
    ['abc', 'time: invalid duration "abc"'],
    ['-', 'time: invalid duration "-"'],
  ];
  for (const [input, want] of recorded) {
    assert.throws(
      () => parseDuration(input),
      (err) => err.message === want,
      `parseDuration(${JSON.stringify(input)}) should say ${want}`,
    );
  }
});

test('G-DUR-1 Seconds() uses Go split arithmetic', () => {
  assert.equal(seconds(0n), 0);
  assert.equal(seconds(SECOND), 1);
  assert.equal(seconds(1500000000n), 1.5);
  assert.equal(seconds(1n), 1e-9);
  assert.equal(seconds(-2500000000n), -2.5);
});

test('Seconds() stays exact past 2**53 nanoseconds', () => {
  // ~104 days. A Number-backed duration would already have lost integer
  // precision here; the BigInt representation has not.
  const d = 9007199254740993n; // 2**53 + 1
  assert.equal(seconds(d), 9007199 + 254740993 / 1e9);
});
