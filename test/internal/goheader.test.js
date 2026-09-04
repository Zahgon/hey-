// Expectations recorded from go1.26.7 (PHASE 2 probe transcript, section F).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHeaderKey, Header } from '../../src/internal/goheader.js';

test('G-HDR-1 canonicalHeaderKey matches Go', () => {
  const recorded = [
    ['content-type', 'Content-Type'],
    ['X-SOME-thing', 'X-Some-Thing'],
    ['user-agent', 'User-Agent'],
    ['weird_key', 'Weird_key'],
    ['a-b_c', 'A-B_c'],
    ['\u041a\u043b\u044e\u0447', '\u041a\u043b\u044e\u0447'],
    ['\u00e9x', '\u00e9x'],
    ['', ''],
  ];
  for (const [input, want] of recorded) {
    assert.equal(canonicalHeaderKey(input), want, JSON.stringify(input));
  }
});

test('G-HDR-1 underscore is a token char, not a separator', () => {
  // The naive "capitalise after every non-alphanumeric" rule gives "Weird_Key".
  assert.equal(canonicalHeaderKey('weird_key'), 'Weird_key');
  assert.notEqual(canonicalHeaderKey('weird_key'), 'Weird_Key');
});

test('G-HDR-1 a non-token key is stored verbatim', () => {
  const h = new Header();
  h.Set('\u041a\u043b\u044e\u0447', 'v');
  assert.equal(h.Get('\u041a\u043b\u044e\u0447'), 'v');
  assert.deepEqual([...h.keys()], ['\u041a\u043b\u044e\u0447']);
});

test('Header stores canonical keys and Get is case-insensitive', () => {
  const h = new Header();
  h.Set('content-type', 'text/html');
  h.Set('X-SOME-thing', 'v');
  assert.deepEqual([...h.keys()].sort(), ['Content-Type', 'X-Some-Thing']);
  assert.equal(h.Get('CONTENT-TYPE'), 'text/html');
  assert.equal(h.Get('Content-Type'), 'text/html');
});

test('Header.Get returns "" for a missing key, never undefined', () => {
  const h = new Header();
  assert.equal(h.Get('User-Agent'), '');
  assert.notEqual(h.Get('User-Agent'), undefined);
});

test('Header.Add appends, Header.Set replaces', () => {
  const h = new Header();
  h.Add('X-A', '1');
  h.Add('X-A', '2');
  assert.deepEqual(h.get('X-A'), ['1', '2']);
  assert.equal(h.Get('X-A'), '1');
  h.Set('X-A', '3');
  assert.deepEqual(h.get('X-A'), ['3']);
});

test('a header key shaped like a prototype property is safe', () => {
  const h = new Header();
  h.Set('__proto__', 'pwned');
  h.Set('constructor', 'pwned');
  assert.equal(h.Get('__proto__'), 'pwned');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
