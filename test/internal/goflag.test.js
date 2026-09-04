// Go `flag` semantics. Behaviours here were confirmed against the compiled
// hey binary (see verification/cli-diff.mjs, which diffs the whole CLI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlagSet, ErrHelp, FlagError } from '../../src/internal/goflag.js';

function newSet() {
  const f = new FlagSet('hey');
  f.Usage = () => {};
  return f;
}

test('G-FLAG-1 parsing stops at the first non-flag argument', () => {
  const f = newSet();
  const n = f.Int('n', 200);
  const o = f.String('o', '');
  f.parse(['-n', '5', 'http://x', '-o', 'csv']);
  assert.equal(n.value, 5);
  assert.equal(o.value, '', '-o after the URL must NOT be parsed as a flag');
  assert.deepEqual(f.Args(), ['http://x', '-o', 'csv']);
});

test('G-FLAG-2 a bool flag never consumes the next argument', () => {
  const f = newSet();
  const h2 = f.Bool('h2', false);
  const n = f.Int('n', 200);
  f.parse(['-h2', 'true', '-n', '1']);
  assert.equal(h2.value, true);
  assert.equal(n.value, 200, '-n is positional here and keeps its default');
  assert.deepEqual(f.Args(), ['true', '-n', '1']);
});

test('G-FLAG-3 single and double dash are equivalent', () => {
  const f = newSet();
  const n = f.Int('n', 200);
  const c = f.Int('c', 50);
  f.parse(['--n=5', '--c', '10']);
  assert.equal(n.value, 5);
  assert.equal(c.value, 10);
});

test('G-FLAG-5 "--" terminates flag parsing', () => {
  const f = newSet();
  const n = f.Int('n', 200);
  f.parse(['--', '-n', '5']);
  assert.equal(n.value, 200);
  assert.deepEqual(f.Args(), ['-n', '5']);
});

test('G-FLAG-4 an unknown flag is a FlagError', () => {
  const f = newSet();
  f.Int('n', 200);
  assert.throws(() => f.parse(['-badflag']), FlagError);
});

test('G-FLAG-4 every numeric parse failure flattens to "parse error"', () => {
  for (const [kind, bad] of [['Int', 'abc'], ['Float64', 'x'], ['Duration', 'bogus'], ['Duration', '1d']]) {
    const f = newSet();
    f[kind]('v', kind === 'Duration' ? 0n : 0);
    assert.throws(
      () => f.parse([`-v`, bad]),
      (err) => err instanceof FlagError && /invalid value .* for flag -v: parse error/u.test(err.message),
      `${kind} ${bad}`,
    );
  }
});

test('G-FLAG-4 -help throws ErrHelp (exit 0), not FlagError', () => {
  const f = newSet();
  f.String('h', '');
  assert.throws(() => f.parse(['-help']), ErrHelp);
});

test('a flag missing its argument is an error', () => {
  const f = newSet();
  f.Int('n', 200);
  assert.throws(() => f.parse(['-n']), FlagError);
});

test('flag.Var collects repeated occurrences in order', () => {
  const f = newSet();
  const collected = [];
  f.Var({ Set: (v) => collected.push(v), String: () => '' }, 'H');
  f.parse(['-H', 'A: 1', '-H', 'B: 2', 'http://x']);
  assert.deepEqual(collected, ['A: 1', 'B: 2']);
  assert.deepEqual(f.Args(), ['http://x']);
});

test('int flags reject a float and honour the int64 range', () => {
  const f = newSet();
  f.Int('t', 20);
  assert.throws(() => f.parse(['-t', '1.5']), FlagError);

  const g = newSet();
  g.Int('t', 20);
  assert.throws(
    () => g.parse(['-t', '99999999999999999999']),
    (err) => /value out of range/u.test(err.message),
  );
});

test('bool flags accept Go\u2019s literal set via =', () => {
  for (const [raw, want] of [['1', true], ['t', true], ['TRUE', true], ['0', false], ['f', false], ['False', false]]) {
    const f = newSet();
    const b = f.Bool('b', !want);
    f.parse([`-b=${raw}`]);
    assert.equal(b.value, want, `-b=${raw}`);
  }
});
