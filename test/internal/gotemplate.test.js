// text/template subset. The heavy verification for this module is
// test/differential.test.js, which renders 607 real report jobs through it and
// compares against Go. These tests pin the individual semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newTemplate, formatV, formatFloatG, GoDuration, NO_VALUE } from '../../src/internal/gotemplate/index.js';

const render = (text, data, funcs = {}) => newTemplate('tmpl', text, funcs).execute(data);

test('G-TMPL-1 %v on a float64 matches Go\u2019s %g', () => {
  const recorded = [
    [0, '0'],
    [1, '1'],
    [1.5, '1.5'],
    [1e-5, '1e-05'],
    [1e-4, '0.0001'],
    [0.0001234, '0.0001234'],
    [100000, '100000'],
    [1e20, '1e+20'],
    [1e21, '1e+21'],
    [123456789.0, '1.23456789e+08'],
    [0.1, '0.1'],
    [1 / 3, '0.3333333333333333'],
    [NaN, 'NaN'],
    [Infinity, '+Inf'],
    [1e-7, '1e-07'],
  ];
  for (const [input, want] of recorded) {
    assert.equal(formatFloatG(input), want, `%v of ${input}`);
  }
});

test('G-TMPL-1 diverges from String() exactly where Go does', () => {
  assert.equal(formatFloatG(1e-5), '1e-05');
  assert.equal(String(1e-5), '0.00001');
  assert.equal(formatFloatG(123456789), '1.23456789e+08');
  assert.equal(String(123456789), '123456789');
});

test('G-TMPL-4 ints and floats render differently', () => {
  assert.equal(formatV(123456789n), '123456789');
  assert.equal(formatV(123456789.0), '1.23456789e+08');
});

test('G-TMPL-2 a missing MAP key renders "<no value>" without erroring', () => {
  assert.equal(render('{{ .Missing }}', new Map()), '<no value>');
  assert.equal(render('{{ .A.B.C }}', new Map()), '<no value>');
  assert.equal(formatV(NO_VALUE), '<no value>');
});

test('G-TMPL-2 a missing STRUCT field is an execution error, as in Go', () => {
  // Go: can't evaluate field Missing in type requester.Report
  assert.throws(() => render('{{ .Missing }}', { Slowest: 1.5 }), /can't evaluate field Missing/u);
});

test('a user template cannot walk the prototype chain', () => {
  // `-o` takes arbitrary template text, so this is an untrusted-input boundary.
  // Go rejects .constructor as a non-existent field; so must the port, rather
  // than resolving it to a function and invoking it.
  for (const expr of ['{{ .constructor }}', '{{ .__proto__ }}', '{{ .toString }}', '{{ .constructor.constructor }}']) {
    assert.throws(() => render(expr, { Slowest: 1.5 }), /can't evaluate field/u, expr);
  }
});

test('G-SORT-2 range over a map uses Go key order', () => {
  assert.equal(
    render('{{ range $k, $v := .M }}{{$k}}={{$v}};{{ end }}', {
      M: new Map([['zeta', 1n], ['alpha', 2n], ['Beta', 3n], ['', 9n]]),
    }),
    '=9;Beta=3;alpha=2;zeta=1;',
  );
  assert.equal(
    render('{{ range $k, $v := .M }}{{$k}}={{$v}};{{ end }}', {
      M: new Map([[500, 1n], [200, 7n], [-5, 2n]]),
    }),
    '-5=2;200=7;500=1;',
  );
});

test('method values resolve, so .Total.Seconds works', () => {
  assert.equal(render('{{ .Total.Seconds }}', { Total: new GoDuration(2500000000n) }), '2.5');
});

test('if/else, with, and range/else behave as in Go', () => {
  assert.equal(render('{{ if gt .N 0 }}Y{{ else }}N{{ end }}', { N: 5n }), 'Y');
  assert.equal(render('{{ if gt .N 0 }}Y{{ else }}N{{ end }}', { N: 0n }), 'N');
  assert.equal(render('{{ if .S }}Y{{ else if .T }}E{{ else }}N{{ end }}', { S: '', T: 'x' }), 'E');
  assert.equal(render('{{ range .L }}<{{.}}>{{ else }}EMPTY{{ end }}', { L: [] }), 'EMPTY');
  assert.equal(render('{{ with .V }}{{.}}{{ end }}', { V: 'here' }), 'here');
  assert.equal(render('{{ with .V }}{{.}}{{ else }}none{{ end }}', { V: '' }), 'none');
});

test('pipelines pass the previous stage as the LAST argument', () => {
  const funcs = { wrap: (a, b) => `${a}|${b}` };
  assert.equal(render('{{ "x" | wrap "y" }}', {}, funcs), 'y|x');
});

test('builtin len/index/eq/not work on the port\u2019s value model', () => {
  assert.equal(render('{{ len .L }}', { L: [1, 2, 3] }), '3');
  assert.equal(render('{{ len .M }}', { M: new Map([['a', 1n]]) }), '1');
  assert.equal(render('{{ index .L 1 }}', { L: [10n, 20n] }), '20');
  assert.equal(render('{{ if eq .A "x" }}Y{{ end }}', { A: 'x' }), 'Y');
  assert.equal(render('{{ if not .A }}Y{{ end }}', { A: '' }), 'Y');
});

test('variables, comments and trim markers', () => {
  assert.equal(render('{{ $x := .A }}{{ $x }}-{{ $x }}', { A: 'q' }), 'q-q');
  assert.equal(render('a{{/* note */}}b', {}), 'ab');
  assert.equal(render('a  {{- .V }}', { V: 'b' }), 'ab');
  assert.equal(render('{{ .V -}}  b', { V: 'a' }), 'ab');
});

test('an undefined function is a parse-time error, not silent output', () => {
  assert.throws(() => render('{{ nosuchfunc . }}', {}), /not defined/u);
});

test('an out-of-range index is an execution error, matching Go', () => {
  assert.throws(() => render('{{ index .L 0 }}', { L: [] }), /index out of range/u);
});

test('a nil map/slice ranges as empty and has len 0', () => {
  assert.equal(render('{{ range .L }}x{{ end }}|{{ len .L }}', { L: [] }), '|0');
});
