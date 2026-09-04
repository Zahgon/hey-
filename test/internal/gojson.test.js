// Expectations recorded from go1.26.7's encoding/json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marshalJSON } from '../../src/internal/gojson.js';
import { nilMap, nilSlice } from '../../src/internal/gotemplate/value.js';

test('G-JSON-2 float encoding matches Go', () => {
  const recorded = [
    [0, '0'],
    [1, '1'],
    [1.5, '1.5'],
    [1e-6, '0.000001'],
    [1e-7, '1e-7'],
    [9.9e-7, '9.9e-7'],
    [1e-9, '1e-9'],
    [1e20, '100000000000000000000'],
    [1e21, '1e+21'],
    [1e22, '1e+22'],
    [0.1, '0.1'],
    [-2.5, '-2.5'],
    [1e100, '1e+100'],
    [123456789.0, '123456789'],
  ];
  for (const [input, want] of recorded) {
    assert.equal(marshalJSON(input), want, `json of ${input}`);
  }
});

test('G-JSON-2 differs from JSON.stringify below 1e-6', () => {
  assert.equal(marshalJSON(1e-9), '1e-9');
  // Go strips the leading zero from a two-digit negative exponent.
  assert.equal(marshalJSON(1e-7), '1e-7');
  // And keeps positional form at exactly 1e-6, where JS switches earlier.
  assert.equal(marshalJSON(1e-6), '0.000001');
});

test('G-JSON-1 strings are HTML-escaped', () => {
  const recorded = [
    ['a<b&c', '"a\\u003cb\\u0026c"'],
    ['x>y', '"x\\u003ey"'],
    ['\u2028\u2029', '"\\u2028\\u2029"'],
    ['tab\there', '"tab\\there"'],
    ['\x00', '"\\u0000"'],
    ['\u00e9', '"\u00e9"'],
    ['"q"', '"\\"q\\""'],
  ];
  for (const [input, want] of recorded) {
    assert.equal(marshalJSON(input), want, JSON.stringify(input));
  }
  // JSON.stringify leaves <, > and & alone — the reason this port exists.
  assert.equal(JSON.stringify('a<b&c'), '"a<b&c"');
});

test('G-JSON-3 map keys are emitted sorted', () => {
  const strings = new Map([['zeta', 1n], ['alpha', 2n], ['Beta', 3n], ['', 9n]]);
  assert.equal(marshalJSON(strings), '{"":9,"Beta":3,"alpha":2,"zeta":1}');
  const ints = new Map([[500, 1n], [200, 7n], [-5, 2n]]);
  assert.equal(marshalJSON(ints), '{"-5":2,"200":7,"500":1}');
});

test('G-TMPL-5 nil marshals to null, empty to {} / []', () => {
  assert.equal(marshalJSON(nilMap()), 'null');
  assert.equal(marshalJSON(nilSlice()), 'null');
  assert.equal(marshalJSON(new Map()), '{}');
  assert.equal(marshalJSON([]), '[]');
});

test('G-JSON-4 NaN/Inf are an error, which jsonify swallows into ""', () => {
  assert.equal(marshalJSON(NaN), '');
  assert.equal(marshalJSON(Infinity), '');
  assert.equal(marshalJSON(-Infinity), '');
  // Not "null" — JSON.stringify's behaviour, which would silently invent data.
  assert.notEqual(marshalJSON(NaN), 'null');
});

test('int64 values stay exact', () => {
  assert.equal(marshalJSON(9007199254740993n), '9007199254740993');
});
