// text/template builtin functions.
//
// `-o` accepts an arbitrary Go template, so these are reachable from the CLI.
// Every expectation is a value RECORDED from go1.26.7's text/template, not a
// guess -- writing these tests found four bugs in the first implementation:
// %05d padded with spaces, urlquery used %20 instead of '+', print joined
// without Go's spacing rule, and index on a string returned a character
// instead of the byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newTemplate } from '../../src/internal/gotemplate/index.js';
import { GoDuration } from '../../src/internal/gotemplate/value.js';

const render = (text, data = null) => newTemplate('tmpl', text, {}).execute(data);

test('printf matches Go fmt.Sprintf', () => {
  const recorded = [
    ['{{ printf "%d" 42 }}', '42'],
    ['{{ printf "%s-%s" "a" "b" }}', 'a-b'],
    ['{{ printf "%05d" 42 }}', '00042'],
    ['{{ printf "%.2f" 3.14159 }}', '3.14'],
    ['{{ printf "%q" "hi" }}', '"hi"'],
    ['{{ printf "%x" 255 }}', 'ff'],
    ['{{ printf "%X" 255 }}', 'FF'],
    ['{{ printf "%t" true }}', 'true'],
    ['{{ printf "100%%" }}', '100%'],
    ['{{ printf "%v" 1.5 }}', '1.5'],
  ];
  for (const [input, want] of recorded) {
    assert.equal(render(input), want, input);
  }
});

test('printf zero-pads after the sign, and left-aligns with "-"', () => {
  assert.equal(render('{{ printf "%05d" -42 }}'), '-0042');
  assert.equal(render('{{ printf "%-5d|" 42 }}'), '42   |');
  assert.equal(render('{{ printf "%5d|" 42 }}'), '   42|');
});

test('html escapes Go\u2019s five characters', () => {
  // Recorded: {{ html "<b>&'\"" }} => &lt;b&gt;&amp;&#39;&#34;
  assert.equal(render('{{ html "<b>&\'\\"" }}'), '&lt;b&gt;&amp;&#39;&#34;');
});

test('js escapes for a JavaScript string context', () => {
  // Recorded: {{ js "a<b'c" }} => a\u003Cb\'c
  assert.equal(render('{{ js "a<b\'c" }}'), "a\\u003Cb\\'c");
});

test('urlquery is url.QueryEscape: space becomes "+"', () => {
  // Recorded: {{ urlquery "a b&c" }} => a+b%26c
  assert.equal(render('{{ urlquery "a b&c" }}'), 'a+b%26c');
  // encodeURIComponent would give "a%20b%26c" -- the bug this pins.
  assert.notEqual(render('{{ urlquery "a b&c" }}'), 'a%20b%26c');
});

test('slice returns a sub-slice and keeps len() consistent', () => {
  assert.equal(render('{{ slice "abcdef" 1 3 }}'), 'bc');
  assert.equal(render('{{ len (slice "abcdef" 1 3) }}'), '2');
});

test('print applies fmt.Sprint spacing, println always spaces', () => {
  // Recorded: {{ print "a" 1 true }} => "a1 true"
  // A space appears only between two operands when NEITHER is a string.
  assert.equal(render('{{ print "a" 1 true }}'), 'a1 true');
  assert.equal(render('{{ print 1 2 }}'), '1 2');
  assert.equal(render('{{ print "a" "b" }}'), 'ab');
  assert.equal(render('{{ println "x" }}'), 'x\n');
});

test('index on a string yields the BYTE, as in Go', () => {
  // Recorded: {{ index "abc" 1 }} => 98
  assert.equal(render('{{ index "abc" 1 }}'), '98');
  // Multi-byte: Go indexes bytes, so the first byte of "é" is 0xC3 = 195.
  assert.equal(render('{{ index "\u00e9" 0 }}'), '195');
});

test('and/or return the deciding operand, not a boolean', () => {
  // Recorded: "2|0|3|1"
  assert.equal(render('{{ and 1 2 }}|{{ and 0 2 }}|{{ or 0 3 }}|{{ or 1 2 }}'), '2|0|3|1');
});

test('not/ne/le/ge match Go', () => {
  assert.equal(render('{{ not "" }}|{{ not "x" }}'), 'true|false');
  assert.equal(render('{{ ne 1 2 }}|{{ le 1 2 }}|{{ ge 2 2 }}'), 'true|true|true');
});

test('call invokes a function value', () => {
  const t = newTemplate('tmpl', '{{ call .F 2 3 }}', {});
  assert.equal(t.execute({ F: (a, b) => a + b }), '5');
});

test('an unknown function is rejected at PARSE time, like template.Must', () => {
  assert.throws(() => render('{{ nosuchfunc . }}'), /function "nosuchfunc" not defined/u);
});

test('GoDuration.String matches time.Duration.String', () => {
  // All recorded from go1.26.7.
  const recorded = [
    [0n, '0s'],
    [1n, '1ns'],
    [999n, '999ns'],
    [1000n, '1\u00b5s'],
    [1500n, '1.5\u00b5s'],
    [1000000n, '1ms'],
    [100000000n, '100ms'],
    [1000000000n, '1s'],
    [1500000000n, '1.5s'],
    [5400000000000n, '1h30m0s'],
    [3661000000000n, '1h1m1s'],
    [-2500000000n, '-2.5s'],
    [90000000000n, '1m30s'],
  ];
  for (const [ns, want] of recorded) {
    assert.equal(new GoDuration(ns).String(), want, `${ns}ns`);
  }
});

test('a zero Duration is falsy in a template if, as in Go', () => {
  assert.equal(render('{{ if .D }}Y{{ else }}N{{ end }}', { D: new GoDuration(0n) }), 'N');
  assert.equal(render('{{ if .D }}Y{{ else }}N{{ end }}', { D: new GoDuration(1n) }), 'Y');
});

test('range over an integer does not materialise the sequence', () => {
  assert.equal(render('{{ range 3 }}x{{ end }}'), 'xxx');
  // A large bound must not allocate: this would OOM with an array.
  const t = newTemplate('tmpl', '{{ range 5000000 }}{{ if false }}x{{ end }}{{ end }}ok', {});
  assert.equal(t.execute(null).endsWith('ok'), true);
});
