// Unit tests for the CLI helpers in bin/hey.js.
//
// These were previously exercised only end-to-end, through a subprocess in
// verification/cli-diff.mjs -- which skips when the Go reference binary is
// absent (CI containers, other machines). That left real functions with zero
// executed coverage. Each expectation below is the behaviour the compiled Go
// binary was observed to produce.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HeaderSlice,
  newRequest,
  setBasicAuth,
  toUpperGo,
  parseInputWithRegexp,
  headerRegexp,
  usage,
} from '../bin/hey.js';
import { Header } from '../src/internal/goheader.js';
import { FlagSet } from '../src/internal/goflag.js';
import { Work } from '../src/requester/requester.js';
import { newTemplate } from '../src/internal/gotemplate/index.js';

test('HeaderSlice collects repeated -H values in order (Go flag.Value)', () => {
  const hs = new HeaderSlice();
  assert.deepEqual(hs.values, []);
  hs.Set('A: 1');
  hs.Set('B: 2');
  assert.deepEqual(hs.values, ['A: 1', 'B: 2']);
  // Go's headerSlice.String() is fmt.Sprintf("%s", *h) -> "[A: 1 B: 2]".
  assert.equal(hs.String(), '[A: 1 B: 2]');
});

test('HeaderSlice wired through FlagSet.Var behaves like -H', () => {
  const f = new FlagSet('hey');
  f.Usage = () => {};
  const hs = f.Var(new HeaderSlice(), 'H');
  f.parse(['-H', 'X-One: 1', '-H', 'X-Two: 2', 'http://x']);
  assert.deepEqual(hs.values, ['X-One: 1', 'X-Two: 2']);
  assert.deepEqual(f.Args(), ['http://x']);
});

test('newRequest validates the method the way net/http does', () => {
  const req = newRequest('GET', 'http://example.com/p');
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'http://example.com/p');
  assert.equal(req.host, '');
  assert.equal(req.contentLength, 0);
  assert.equal(req.body, null);
  assert.ok(req.header instanceof Header);

  // A space is not a token character.
  assert.throws(
    () => newRequest('BAD METHOD', 'http://x'),
    /net\/http: invalid method "BAD METHOD"/u,
  );
});

test('newRequest rejects a URL with no scheme, as http.NewRequest does', () => {
  // Observed: GO exits 1 with `parse "://bad": missing protocol scheme`.
  assert.throws(
    () => newRequest('GET', '://bad'),
    /parse ":\/\/bad": missing protocol scheme/u,
  );
  // A relative URL is accepted by http.NewRequest and only fails at Do time.
  assert.doesNotThrow(() => newRequest('GET', 'true'));
});

test('setBasicAuth writes the base64 header Go produces', () => {
  const req = newRequest('GET', 'http://x');
  setBasicAuth(req, 'username', 'password');
  // Matches requester_test.go's expected value exactly.
  assert.equal(req.header.Get('Authorization'), 'Basic dXNlcm5hbWU6cGFzc3dvcmQ=');
});

test('setBasicAuth encodes non-ASCII credentials as UTF-8', () => {
  const req = newRequest('GET', 'http://x');
  setBasicAuth(req, 'u\u00e9ser', 'p\u00e4ss');
  const decoded = Buffer.from(req.header.Get('Authorization').slice(6), 'base64').toString('utf8');
  assert.equal(decoded, 'u\u00e9ser:p\u00e4ss');
});

test('toUpperGo is rune-wise, never one-to-many like toUpperCase', () => {
  assert.equal(toUpperGo('get'), 'GET');
  assert.equal(toUpperGo('post'), 'POST');
  // strings.ToUpper leaves these alone; toUpperCase would expand them.
  assert.equal(toUpperGo('\u00df'), '\u00df');
  assert.equal('\u00df'.toUpperCase(), 'SS', 'the JS behaviour being avoided');
  assert.equal(toUpperGo('\ufb01'), '\ufb01');
  assert.equal(toUpperGo(''), '');
});

test('parseInputWithRegexp throws Go\u2019s message on no match', () => {
  assert.throws(
    () => parseInputWithRegexp('nocolon', headerRegexp),
    /could not parse the provided input; input = nocolon/u,
  );
});

test('the usage text carries a literal tab before the -host description', () => {
  assert.ok(usage.includes('  -host\tHTTP Host header.'), 'Go uses a tab here, not spaces');
  assert.ok(usage.includes('(default for current machine is %d cores)'));
});

test('Work.writer() defaults to stdout when no Writer is supplied', () => {
  const w = new Work({ N: 1, C: 1 });
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (s) => { written.push(s); return true; };
  try {
    w.writer().write('hello');
  } finally {
    process.stdout.write = original;
  }
  assert.deepEqual(written, ['hello']);
});

test('Work.writer() returns the supplied Writer unchanged', () => {
  const sink = { write() {} };
  assert.equal(new Work({ Writer: sink }).writer(), sink);
});

test('FlagSet.NArg counts the positional arguments', () => {
  const f = new FlagSet('hey');
  f.Usage = () => {};
  f.Int('n', 200);
  f.parse(['-n', '5', 'http://x', 'extra']);
  assert.equal(f.NArg(), 2);
  assert.deepEqual(f.Args(), ['http://x', 'extra']);

  const g = new FlagSet('hey');
  g.Usage = () => {};
  g.Int('n', 200);
  g.parse(['-n', '5']);
  assert.equal(g.NArg(), 0, 'hey uses NArg() < 1 to detect a missing URL');
});

test('Header.Del removes a canonicalised key', () => {
  const h = new Header();
  h.Set('X-Some-Thing', 'v');
  assert.equal(h.Get('x-some-thing'), 'v');
  h.Del('x-SOME-thing');
  assert.equal(h.Get('X-Some-Thing'), '');
  assert.equal(h.has('X-Some-Thing'), false);
});

test('the template lt builtin matches Go', () => {
  const render = (t) => newTemplate('tmpl', t, {}).execute(null);
  assert.equal(render('{{ lt 1 2 }}|{{ lt 2 1 }}|{{ lt 1 1 }}'), 'true|false|false');
  // Strings compare as UTF-8 bytes: 'B' (0x42) sorts before 'a' (0x61).
  assert.equal(render('{{ lt "Beta" "alpha" }}'), 'true');
});

test('pathError renders like Go\u2019s *fs.PathError', async () => {
  const { pathError } = await import('../bin/hey.js');
  // Observed from the compiled binary:
  //   open /nonexistent: no such file or directory
  //   read /tmp/dir: is a directory      <- ReadFile opens, then fails on read
  assert.equal(pathError('open', '/nonexistent', { code: 'ENOENT' }), 'open /nonexistent: no such file or directory');
  assert.equal(pathError('read', '/tmp/dir', { code: 'EISDIR' }), 'read /tmp/dir: is a directory');
  assert.equal(pathError('open', '/root/x', { code: 'EACCES' }), 'open /root/x: permission denied');
  assert.equal(pathError('open', '/a/b', { code: 'ENOTDIR' }), 'open /a/b: not a directory');
  // An unmapped errno falls back to the raw message rather than inventing one.
  assert.equal(pathError('open', '/x', { code: 'EWEIRD', message: 'boom' }), 'open /x: boom');
});

test('errAndExit writes msg + newline to stderr and returns 1', async () => {
  const { errAndExit } = await import('../bin/hey.js');
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(s); return true; };
  let code;
  try {
    code = errAndExit('boom');
  } finally {
    process.stderr.write = original;
  }
  assert.equal(code, 1);
  assert.equal(chunks.join(''), 'boom\n');
});

test('usageAndExit prints msg, a blank line, usage, a newline, and returns 1', async () => {
  const { usageAndExit } = await import('../bin/hey.js');
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(s); return true; };
  let code;
  const flags = { usage: () => process.stderr.write('USAGE') };
  try {
    code = usageAndExit('-n cannot be less than -c.', flags);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(code, 1);
  // Go: msg, "\n\n", usage, "\n"
  assert.equal(chunks.join(''), '-n cannot be less than -c.\n\nUSAGE\n');
});

test('usageAndExit with an empty message prints only usage', async () => {
  const { usageAndExit } = await import('../bin/hey.js');
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(s); return true; };
  try {
    usageAndExit('', { usage: () => process.stderr.write('USAGE') });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(chunks.join(''), 'USAGE\n');
});
