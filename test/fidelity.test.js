// Regression tests for the PHASE 13 adversarial-review findings. Each was a
// real divergence from Go, reproduced against the compiled binary before the
// fix. Naming follows the finding IDs in MIGRATION-REPORT-GO-JS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Work } from '../src/requester/requester.js';
import { Header } from '../src/internal/goheader.js';
import { FlagSet, FlagError } from '../src/internal/goflag.js';

function newServer(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 50;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      port: server.address().port,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      }),
    }));
  });
}

const newRequest = (method, url) => ({
  method, url, host: '', header: new Header(), contentLength: 0, body: null,
});

class Buf {
  constructor() { this.text = ''; }
  write(s) { this.text += s; }
}

async function run(options) {
  const out = new Buf();
  await new Work({ Writer: out, ...options }).Run();
  return out.text;
}

test('H1 a truncated body is a SUCCESS, because Go discards io.Copy errors', async () => {
  const server = await newServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '100' });
    res.write('12345');
    res.socket.end();
  });
  try {
    const out = await run({ Request: newRequest('GET', server.url), N: 2, C: 1, Timeout: 5 });
    assert.match(out, /\[200\]\t2 responses/u, 'Go reports 200s here, not errors');
    assert.doesNotMatch(out, /unexpected EOF/u);
  } finally {
    await server.close();
  }
});

test('H2 a keep-alive connection closed by the peer is retried, not reported', async () => {
  const server = await newServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '2', Connection: 'keep-alive' });
    res.end('ok');
    setTimeout(() => req.socket.destroy(), 5).unref();
  });
  try {
    const out = await run({ Request: newRequest('GET', server.url), N: 6, C: 1, Timeout: 5 });
    assert.match(out, /\[200\]\t6 responses/u, 'no phantom ECONNRESET/socket-hang-up errors');
    assert.doesNotMatch(out, /Error distribution/u);
  } finally {
    await server.close();
  }
});

test('H4 a cross-host redirect strips Authorization and Cookie', async () => {
  const seen = [];
  const target = await newServer((req, res) => {
    seen.push({ auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  const origin = await newServer((req, res) => {
    res.writeHead(302, { Location: `http://localhost:${target.port}/dest` });
    res.end();
  });
  try {
    const req = newRequest('GET', origin.url);
    req.header.Set('Authorization', 'Bearer SECRET');
    req.header.Set('Cookie', 'sid=abc');
    await run({ Request: req, N: 1, C: 1, Timeout: 5 });
    assert.deepEqual(seen, [{ auth: null, cookie: null }], 'credentials must not cross hosts');
  } finally {
    await origin.close();
    await target.close();
  }
});

test('H4 a same-host redirect KEEPS credentials', async () => {
  const seen = [];
  const server = await newServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/dest' });
      return res.end();
    }
    seen.push(req.headers.authorization ?? null);
    res.writeHead(200, { 'Content-Length': '2' });
    return res.end('ok');
  });
  try {
    const req = newRequest('GET', `${server.url}/start`);
    req.header.Set('Authorization', 'Bearer SECRET');
    await run({ Request: req, N: 1, C: 1, Timeout: 5 });
    assert.deepEqual(seen, ['Bearer SECRET']);
  } finally {
    await server.close();
  }
});

test('H5 -t is an absolute deadline, not a socket-idle timer', async () => {
  const timers = [];
  const server = await newServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    let n = 0;
    const t = setInterval(() => {
      if (n++ > 20) { clearInterval(t); return res.end(); }
      return res.write('x');
    }, 300);
    timers.push(t);
  });
  try {
    const started = Date.now();
    const out = await run({ Request: newRequest('GET', server.url), N: 1, C: 1, Timeout: 1 });
    const elapsed = Date.now() - started;
    // A byte every 300ms would re-arm an idle timer forever.
    assert.ok(elapsed < 2500, `-t 1 must bound the whole exchange, took ${elapsed}ms`);
    assert.match(out, /Client\.Timeout exceeded/u);
  } finally {
    for (const t of timers) clearInterval(t);
    await server.close();
  }
});

test('F7 a redirect loop costs 10 requests and names the refused Location', async () => {
  let hits = 0;
  const server = await newServer((req, res) => {
    hits++;
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') ?? 0);
    res.writeHead(302, { Location: `/redir?n=${n + 1}` });
    res.end();
  });
  try {
    const out = await run({ Request: newRequest('GET', `${server.url}/redir?n=0`), N: 1, C: 1, Timeout: 5 });
    assert.equal(hits, 10, 'Go checks the cap BEFORE sending, so 10 requests, not 11');
    assert.match(out, /Get "\/redir\?n=10": stopped after 10 redirects/u);
  } finally {
    await server.close();
  }
});

test('F8 the QPS ticker drops missed ticks instead of bursting', async () => {
  const arrivals = [];
  let first = true;
  const server = await newServer((req, res) => {
    arrivals.push(Date.now());
    const done = () => { res.writeHead(200, { 'Content-Length': '2' }); res.end('ok'); };
    if (first) { first = false; return setTimeout(done, 1500).unref(); }
    return done();
  });
  try {
    await run({ Request: newRequest('GET', server.url), N: 5, C: 1, QPS: 4, Timeout: 20 });
    const deltas = arrivals.slice(1).map((v, i) => v - arrivals[i]);
    // interval = 250ms. After the stall a burst would show deltas near 0.
    for (const d of deltas.slice(1)) {
      assert.ok(d > 150, `rate limit must hold after a stall, saw deltas ${deltas}`);
    }
  } finally {
    await server.close();
  }
});

test('F11 flag.Int parses with base 0 (octal, hex, underscores)', () => {
  const cases = [['010', 8], ['0x10', 16], ['0b101', 5], ['1_0', 10], ['42', 42], ['-0x1f', -31]];
  for (const [raw, want] of cases) {
    const f = new FlagSet('hey');
    f.Usage = () => {};
    const n = f.Int('n', 0);
    f.parse(['-n', raw]);
    assert.equal(n.value, want, `-n ${raw}`);
  }
});

test('F11 base-0 parsing still rejects what Go rejects', () => {
  for (const raw of ['1.5', '0x', '09', 'abc', '1_', '__1']) {
    const f = new FlagSet('hey');
    f.Usage = () => {};
    f.Int('n', 0);
    assert.throws(() => f.parse(['-n', raw]), FlagError, `-n ${raw}`);
  }
});

test('F15 a user-supplied Accept-Encoding disables transparent gunzip', async () => {
  const zlib = await import('node:zlib');
  const payload = zlib.gzipSync(Buffer.from('x'.repeat(500)));
  const server = await newServer((req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  try {
    const req = newRequest('GET', server.url);
    req.header.Set('Accept-Encoding', 'gzip');
    const out = await run({ Request: req, N: 1, C: 1, Timeout: 5 });
    // Go hands back the raw compressed bytes and keeps the real Content-Length.
    assert.match(out, /Total data:\t\d+ bytes/u, 'size must be reported when we did not decompress');
    assert.match(out, /\[200\]\t1 responses/u);
  } finally {
    await server.close();
  }
});

test('H3 an https target is tunnelled through -x, never sent direct', async () => {
  const https = await import('node:https');
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

  let directHits = 0;
  let connectRequests = [];
  const tlsServer = https.createServer({
    key: readFileSync(join(fixtures, 'key.pem')),
    cert: readFileSync(join(fixtures, 'cert.pem')),
  }, (req, res) => {
    directHits++;
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('ok');
  });
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  const tlsPort = tlsServer.address().port;

  // A real CONNECT proxy, so the tunnel is genuinely exercised.
  const net = await import('node:net');
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    connectRequests.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = proxy.address().port;

  try {
    const out = await run({
      Request: newRequest('GET', `https://127.0.0.1:${tlsPort}/`),
      N: 2,
      C: 1,
      Timeout: 10,
      ProxyAddr: new URL(`http://127.0.0.1:${proxyPort}`),
    });
    assert.match(out, /\[200\]\t2 responses/u);
    assert.deepEqual(connectRequests, [`127.0.0.1:${tlsPort}`], 'must reach the target via CONNECT');
    assert.equal(directHits, 2, 'served through the tunnel');
  } finally {
    await new Promise((r) => { proxy.closeAllConnections?.(); proxy.close(r); });
    await new Promise((r) => { tlsServer.closeAllConnections?.(); tlsServer.close(r); });
  }
});

test('H3 a dead proxy fails with Go\u2019s proxyconnect wording, not a direct request', async () => {
  const https = await import('node:https');
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

  let directHits = 0;
  const tlsServer = https.createServer({
    key: readFileSync(join(fixtures, 'key.pem')),
    cert: readFileSync(join(fixtures, 'cert.pem')),
  }, (req, res) => { directHits++; res.writeHead(200, { 'Content-Length': '2' }); res.end('ok'); });
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  const tlsPort = tlsServer.address().port;

  try {
    const out = await run({
      Request: newRequest('GET', `https://127.0.0.1:${tlsPort}/`),
      N: 1,
      C: 1,
      Timeout: 5,
      ProxyAddr: new URL('http://127.0.0.1:1'),
    });
    assert.match(out, /proxyconnect tcp:/u, 'Go prefixes proxy dial failures');
    assert.equal(directHits, 0, 'MUST NOT silently fall back to a direct request');
  } finally {
    await new Promise((r) => { tlsServer.closeAllConnections?.(); tlsServer.close(r); });
  }
});

test('H6 the -z timer chains past Node\u2019s 2**31-1 ms setTimeout limit', async () => {
  const { sleepThenStop, cancelSleep, MAX_TIMEOUT_MS } = await import('../bin/hey.js');

  // A 30-day wait must not fire immediately (Node would clamp it to 1ms).
  let fired = false;
  const long = sleepThenStop(720 * 3600 * 1000, () => { fired = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired, false, '-z 720h must not elapse in 50ms');
  cancelSleep(long);

  assert.ok(720 * 3600 * 1000 > MAX_TIMEOUT_MS, 'the test bound really does exceed the limit');

  // A short wait still fires.
  const quick = await new Promise((resolve) => {
    const h = sleepThenStop(20, () => resolve('fired'));
    setTimeout(() => resolve(`not-fired:${h.cancelled}`), 300);
  });
  assert.equal(quick, 'fired');

  // Cancellation works.
  let cancelledFired = false;
  const c = sleepThenStop(30, () => { cancelledFired = true; });
  cancelSleep(c);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(cancelledFired, false);
});
