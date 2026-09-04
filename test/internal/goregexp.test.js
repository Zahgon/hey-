// Expectations recorded from go1.26.7 (PHASE 2 probe transcript, sections C/D).
import test from 'node:test';
import assert from 'node:assert/strict';
import { headerRegexp, authRegexp, findStringSubmatch } from '../../src/internal/goregexp.js';

test('headerRegexp matches Go FindStringSubmatch', () => {
  const recorded = [
    ['X-Something: !Y10K:;(He@poverflow?)', ['X-Something: !Y10K:;(He@poverflow?)', 'X-Something', '!Y10K:;(He@poverflow?)']],
    ['X|oh|bad-input: badbadbad', null],
    ['a:b', ['a:b', 'a', 'b']],
    ['a: ', ['a: ', 'a', ' ']],
    ['\u041a\u043b\u044e\u0447: v', null], // \w is ASCII-only in RE2
    ['A:b\nc', ['A:b', 'A', 'b']], // `.` stops at \n
    ['a:  b  ', ['a:  b  ', 'a', 'b  ']],
    ['_coo-kie_:!!bigmonster@1969sid', ['_coo-kie_:!!bigmonster@1969sid', '_coo-kie_', '!!bigmonster@1969sid']],
    ['plus+$*{:boom', null],
    ['a::b', ['a::b', 'a', ':b']],
  ];
  for (const [input, want] of recorded) {
    assert.deepEqual(findStringSubmatch(headerRegexp, input), want, JSON.stringify(input));
  }
});

test('authRegexp matches Go FindStringSubmatch', () => {
  const recorded = [
    ['_coo-kie_:!!bigmonster@1969sid', ['_coo-kie_:!!bigmonster@1969sid', '_coo-kie_', '!!bigmonster@1969sid']],
    ['plus+$*{:boom', ['plus+$*{:boom', 'plus+$*{', 'boom']],
    ['X|oh|bad-input: badbadbad', null],
    ['a:b', null], // `[^\s].+` needs at least two chars after the colon
    ['u:p:x', ['u:p:x', 'u', 'p:x']],
    ['a: b', null],
  ];
  for (const [input, want] of recorded) {
    assert.deepEqual(findStringSubmatch(authRegexp, input), want, JSON.stringify(input));
  }
});

test('G-RE-1 \\s is ASCII-only, so NBSP is a legal value start', () => {
  // Go's `[^\s]` accepts U+00A0; a literal JS `[^\s]` would reject it.
  assert.deepEqual(findStringSubmatch(authRegexp, 'user:\u00a0pw'), ['user:\u00a0pw', 'user', '\u00a0pw']);
  assert.equal(/^[^\s].+/u.test('\u00a0pw'), false, 'naive JS \\s still diverges');

  // Vertical tab likewise: RE2 says not-space, JS says space.
  assert.deepEqual(findStringSubmatch(authRegexp, 'user:\vpw'), ['user:\vpw', 'user', '\vpw']);
});

test('G-RE-1 \\s* after the colon does not eat NBSP', () => {
  assert.deepEqual(findStringSubmatch(headerRegexp, 'K:\u00a0v'), ['K:\u00a0v', 'K', '\u00a0v']);
});

test('G-RE-2 `.` matches carriage return', () => {
  assert.deepEqual(findStringSubmatch(headerRegexp, 'K:a\rb'), ['K:a\rb', 'K', 'a\rb']);
  assert.equal(/^.$/u.test('\r'), false, 'naive JS `.` still diverges');
});

test('`.` still stops at newline, as in RE2', () => {
  assert.deepEqual(findStringSubmatch(headerRegexp, 'K:a\nb'), ['K:a', 'K', 'a']);
});
