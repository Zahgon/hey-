// Coverage ADDED by the port — none of this exists in requester_test.go.
// It pins the behaviours node:http does not provide for free and that the
// migration therefore had to implement: redirects, transparent gzip, the
// client timeout, error aggregation, Stop(), and the CSV/summary output shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { Work } from '../src/requester/requester.js';
import { Header } from '../src/internal/goheader.js';

function newServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      }),
    }));
  });
}

function newRequest(method, url) {
  return { method, url, host: '', header: new Header(), contentLength: 0, body: null };
}

class Buf {
  constructor() {
    this.text = '';
  }

  write(s) {
    this.text += s;
  }
}

async function runAgainst(server, options) {
  const out = new Buf();
  const w = new Work({ Request: newRequest('GET', server.url), Writer: out, ...options });
  await w.Run();
  return out.text;
}

test('follows redirects by default, like Go\u2019s http.Client', async () => {
  let finalHits = 0;
  const server = await newServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { Location: '/done' });
      return res.end();
    }
    finalHits++;
    res.writeHead(200, { 'Content-Length': '2' });
    return res.end('ok');
  });
  try {
    const out = await runAgainst(server, { N: 2, C: 1 });
    assert.equal(finalHits, 2, 'redirect target must be reached');
    assert.match(out, /\[200\]\t2 responses/u);
  } finally {
    await server.close();
  }
});

test('-disable-redirects reports the 3xx itself, with no error', async () => {
  const server = await newServer((req, res) => {
    res.writeHead(302, { Location: '/done' });
    res.end();
  });
  try {
    const out = await runAgainst(server, { N: 2, C: 1, DisableRedirects: true });
    assert.match(out, /\[302\]\t2 responses/u);
    assert.doesNotMatch(out, /Error distribution/u);
  } finally {
    await server.close();
  }
});

test('a redirect loop fails with Go\u2019s "stopped after 10 redirects"', async () => {
  const server = await newServer((req, res) => {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  });
  try {
    const out = await runAgainst(server, { N: 1, C: 1 });
    assert.match(out, /Error distribution/u);
    assert.match(out, /stopped after 10 redirects/u);
  } finally {
    await server.close();
  }
});

test('gzip is requested and transparently decompressed', async () => {
  let sawAcceptEncoding = '';
  const payload = zlib.gzipSync(Buffer.from('x'.repeat(1000)));
  const server = await newServer((req, res) => {
    sawAcceptEncoding = req.headers['accept-encoding'] ?? '';
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  try {
    const out = await runAgainst(server, { N: 1, C: 1 });
    assert.match(sawAcceptEncoding, /gzip/u, 'Go\u2019s Transport adds Accept-Encoding: gzip');
    assert.match(out, /\[200\]\t1 responses/u);
    // Go sets ContentLength to -1 after decompressing, so no size is reported.
    assert.doesNotMatch(out, /Total data/u);
  } finally {
    await server.close();
  }
});

test('-disable-compression does not ask for gzip', async () => {
  let sawAcceptEncoding = 'unset';
  const server = await newServer((req, res) => {
    sawAcceptEncoding = req.headers['accept-encoding'] ?? '';
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  try {
    await runAgainst(server, { N: 1, C: 1, DisableCompression: true });
    assert.doesNotMatch(sawAcceptEncoding, /gzip/u);
  } finally {
    await server.close();
  }
});

test('the client timeout surfaces Go\u2019s Client.Timeout message', async () => {
  const server = await newServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end('late');
    }, 2000).unref();
  });
  try {
    const out = await runAgainst(server, { N: 1, C: 1, Timeout: 1 });
    assert.match(out, /Error distribution/u);
    assert.match(out, /Client\.Timeout exceeded/u);
  } finally {
    await server.close();
  }
});

test('errors are aggregated by message, not dropped', async () => {
  // Port 9 (discard) refuses connections deterministically.
  const out = new Buf();
  const w = new Work({
    Request: newRequest('GET', 'http://127.0.0.1:9/'),
    N: 3,
    C: 1,
    Timeout: 2,
    Writer: out,
  });
  await w.Run();
  assert.match(out.text, /Error distribution/u);
  assert.match(out.text, /\[3\]\t/u, 'all three failures share one bucket');
});

test('Stop() halts workers before the request budget is spent', async () => {
  let hits = 0;
  const server = await newServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  try {
    const out = new Buf();
    const w = new Work({ Request: newRequest('GET', server.url), N: 10000, C: 2, Writer: out });
    const run = w.Run();
    setTimeout(() => w.Stop(), 50);
    await run;
    assert.ok(hits < 10000, `Stop must cut the run short, saw ${hits}`);
    assert.ok(hits > 0, 'some requests should have completed');
  } finally {
    await server.close();
  }
});

test('csv output has the documented 8-column header and one row per request', async () => {
  const server = await newServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  try {
    const out = await runAgainst(server, { N: 5, C: 1, Output: 'csv' });
    const lines = out.trim().split('\n');
    assert.equal(
      lines[0],
      'response-time,DNS+dialup,DNS,Request-write,Response-delay,Response-read,status-code,offset',
    );
    assert.equal(lines.length, 6, 'header + 5 rows');
    for (const row of lines.slice(1)) {
      const cells = row.split(',');
      assert.equal(cells.length, 8);
      assert.equal(cells[6], '200', 'status code column');
      // Every latency column is %4.4f.
      for (const i of [0, 1, 2, 3, 4, 5, 7]) {
        assert.match(cells[i], /^-?\d+\.\d{4}$/u, `column ${i} is %4.4f`);
      }
    }
  } finally {
    await server.close();
  }
});

test('the summary preserves upstream\u2019s literal "%%" in the latency section', async () => {
  const server = await newServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  try {
    const out = await runAgainst(server, { N: 10, C: 2 });
    // hey renders the template and then passes it as an ARGUMENT to Fprintf,
    // so "%%" is never unescaped. Real hey prints "10%% in ... secs".
    assert.match(out, /10%% in /u);
    assert.doesNotMatch(out, /10% in /u);
  } finally {
    await server.close();
  }
});

test('a request body is sent on every request, not just the first', async () => {
  let bodies = [];
  const server = await newServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Length': '2' });
      res.end('ok');
    });
  });
  try {
    const out = new Buf();
    const req = newRequest('POST', server.url);
    const w = new Work({
      Request: req,
      RequestBody: Buffer.from('payload'),
      N: 4,
      C: 1,
      Writer: out,
    });
    await w.Run();
    assert.deepEqual(bodies, ['payload', 'payload', 'payload', 'payload']);
  } finally {
    await server.close();
  }
});

test('N/C integer division ignores the remainder, as Go documents', async () => {
  let hits = 0;
  const server = await newServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  try {
    // 7/2 == 3 per worker, so 6 requests are made and the remainder is dropped.
    await runAgainst(server, { N: 7, C: 2 });
    assert.equal(hits, 6, 'Ignore the case where b.N % b.C != 0');
  } finally {
    await server.close();
  }
});

test('an error message shaped like a prototype key cannot pollute Object', async () => {
  const out = new Buf();
  const w = new Work({ Request: newRequest('GET', 'http://127.0.0.1:9/'), N: 1, C: 1, Timeout: 2, Writer: out });
  // Force the error key to be "__proto__".
  w.report = null;
  await w.Run();
  w.report.errorDist.set('__proto__', 5n);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(w.report.errorDist.get('__proto__'), 5n);
});

test('transport error text matches Go byte-for-byte', async () => {
  // These strings become keys in the "Error distribution" section, so anyone
  // parsing hey's output depends on them. Verified against the compiled binary:
  //   Get "http://127.0.0.1:9/": dial tcp 127.0.0.1:9: connect: connection refused
  const out = new Buf();
  const w = new Work({ Request: newRequest('GET', 'http://127.0.0.1:9/'), N: 2, C: 1, Timeout: 2, Writer: out });
  await w.Run();
  assert.match(
    out.text,
    /\[2\]\tGet "http:\/\/127\.0\.0\.1:9\/": dial tcp 127\.0\.0\.1:9: connect: connection refused/u,
  );
});

test('CRLF header injection is rejected, with Go\u2019s message', async () => {
  const out = new Buf();
  const req = newRequest('GET', 'http://127.0.0.1:9/');
  req.header.Set('X-A', 'v\rEvil: 1');
  const w = new Work({ Request: req, N: 1, C: 1, Timeout: 2, Writer: out });
  await w.Run();
  assert.match(
    out.text,
    /Get "http:\/\/127\.0\.0\.1:9\/": net\/http: invalid header field value for "X-A"/u,
  );
  // The forged header must never have been transmitted.
  assert.doesNotMatch(out.text, /\[200\]/u);
});

test('the two CLI regexps are not vulnerable to catastrophic backtracking', async () => {
  const { headerRegexp, authRegexp, findStringSubmatch } = await import('../src/internal/goregexp.js');
  const adversarial = [
    'a'.repeat(200000),
    'a:'.repeat(60000),
    `${'-'.repeat(100000)}\n`,
    `k:${' '.repeat(200000)}`,
    `k:${'\t'.repeat(200000)}v`,
    '_'.repeat(200000),
  ];
  for (const input of adversarial) {
    for (const re of [headerRegexp, authRegexp]) {
      const started = process.hrtime.bigint();
      findStringSubmatch(re, input);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 250, `regex took ${ms.toFixed(1)}ms on a ${input.length}-char input`);
    }
  }
});

// --- HTTP/2 ----------------------------------------------------------------
// Go: `if b.H2 { http2.ConfigureTransport(tr) } else { tr.TLSNextProto = ... }`
// The else-branch DISABLES h2, so the default must be HTTP/1.1 and -h2 must
// actually negotiate HTTP/2 -- not silently fall back, which would report h1
// numbers to someone benchmarking h2.
import http2 from 'node:http2';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const haveCert = existsSync(join(fixtures, 'cert.pem'));

function newH2Server() {
  const server = http2.createSecureServer({
    key: readFileSync(join(fixtures, 'key.pem')),
    cert: readFileSync(join(fixtures, 'cert.pem')),
    allowHTTP1: true,
  });
  const versions = [];
  server.on('request', (req, res) => {
    versions.push(req.httpVersion);
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2 });
    res.end('ok');
  });
  server.on('sessionError', () => {});
  server.on('clientError', () => {});
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `https://127.0.0.1:${server.address().port}/`,
      versions,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      }),
    }));
  });
}

test('without -h2 requests are HTTP/1.1', { skip: !haveCert && 'test cert not generated' }, async () => {
  const server = await newH2Server();
  try {
    const out = new Buf();
    const w = new Work({ Request: newRequest('GET', server.url), N: 3, C: 1, Timeout: 5, Writer: out });
    await w.Run();
    assert.match(out.text, /\[200\]\t3 responses/u);
    assert.deepEqual([...new Set(server.versions)], ['1.1']);
  } finally {
    await server.close();
  }
});

test('-h2 actually negotiates HTTP/2', { skip: !haveCert && 'test cert not generated' }, async () => {
  const server = await newH2Server();
  try {
    const out = new Buf();
    const w = new Work({ Request: newRequest('GET', server.url), N: 3, C: 1, Timeout: 5, H2: true, Writer: out });
    await w.Run();
    assert.match(out.text, /\[200\]\t3 responses/u);
    assert.deepEqual([...new Set(server.versions)], ['2.0'], 'must not silently fall back to HTTP/1.1');
  } finally {
    await server.close();
  }
});

test('-h2 over plain http:// stays HTTP/1.1, as in Go', async () => {
  let version = '';
  const server = await newServer((req, res) => {
    version = req.httpVersion;
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  try {
    const out = new Buf();
    const w = new Work({ Request: newRequest('GET', server.url), N: 1, C: 1, H2: true, Writer: out });
    await w.Run();
    assert.equal(version, '1.1', 'ConfigureTransport only affects TLS');
  } finally {
    await server.close();
  }
});

test('-q completes without -z (the throttle timer must keep the loop alive)', async () => {
  const server = await newServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  try {
    const out = await runAgainst(server, { N: 4, C: 1, QPS: 20 });
    assert.match(out, /\[200\]\t4 responses/u, 'a rate-limited run must still print its report');
  } finally {
    await server.close();
  }
});

test('an h2 connection failure is reported, not swallowed', async () => {
  // Exercises the HTTP/2 error path (session/stream error -> fail()), which the
  // happy-path h2 tests never reach. Port 1 is closed on every platform.
  const out = new Buf();
  const w = new Work({
    Request: newRequest('GET', 'https://127.0.0.1:1/'),
    N: 1,
    C: 1,
    Timeout: 5,
    H2: true,
    Writer: out,
  });
  await w.Run();
  assert.match(out.text, /Error distribution/u);
  assert.doesNotMatch(out.text, /\[200\]/u);
});
