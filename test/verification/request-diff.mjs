// Diffs the REQUEST this port puts on the wire against the one the compiled Go
// binary puts on the wire, for every flag that shapes a request.
//
// The report differential covers output formatting; the CLI differential covers
// argument handling and error paths. This covers the third surface: method,
// path, headers and body as actually received by a server.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const jsBin = join(here, '..', '..', 'bin', 'hey.js');
const goBin = process.env.HEY_REF ?? '/tmp/hey-ref';
const bodyFile = join(tmpdir(), 'hey-request-diff-body.txt');
writeFileSync(bodyFile, 'file body here');

export const CASES = [
  [],
  ['-T', 'application/json'],
  ['-A', 'text/xml'],
  ['-U', 'MyAgent/9'],
  ['-H', 'X-One: 1', '-H', 'X-Two: 2'],
  ['-H', 'User-Agent: Custom'],
  ['-H', 'user-agent: lower'],
  ['-H', 'X-Dup: a', '-H', 'X-Dup: b'],
  ['-a', 'user:pass'],
  ['-a', 'u\u00e9ser:p\u00e4ss'],
  ['-host', 'example.com'],
  ['-m', 'POST', '-d', 'param=1&other=2'],
  ['-m', 'POST', '-D', bodyFile],
  ['-m', 'put', '-T', 'text/plain'],
  ['-m', 'HEAD'],
  ['-m', 'DELETE'],
  ['-disable-compression'],
  ['-disable-keepalive'],
  ['-T', ''],
  ['-U', 'A', '-H', 'User-Agent: B'],
  ['-A', 'application/json', '-U', 'UA', '-H', 'X-Z: z', '-a', 'u:p',
    '-host', 'h.example', '-m', 'POST', '-d', 'b=1'],
];

function startServer() {
  let captured = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // Sorted, because header ORDER on the wire is chosen by each HTTP
      // client library (Go emits Host first, Node emits it last) and is not
      // part of what hey controls. Names and values must match exactly.
      const headers = {};
      for (const k of Object.keys(req.headers).sort()) {
        if (k === 'connection') continue;
        headers[k] = req.headers[k];
      }
      captured = {
        method: req.method,
        url: req.url,
        headers,
        body: Buffer.concat(chunks).toString(),
      };
      res.writeHead(200, { 'Content-Length': '2' });
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      take: () => {
        const c = captured;
        captured = null;
        return c;
      },
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      }),
    }));
  });
}

const settle = () => new Promise((r) => { setTimeout(r, 60); });

/**
 * Must be ASYNC. The capture server runs in this same process, so a
 * spawnSync here would block the event loop, the server could never answer,
 * and every child would sit until its timeout.
 */
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function compareRequests() {
  const server = await startServer();
  const url = `http://127.0.0.1:${server.port}/p?q=1`;
  const diffs = [];
  try {
    for (const args of CASES) {
      const full = ['-n', '1', '-c', '1', ...args, url];

      await run(goBin, full);
      await settle();
      const go = server.take();

      await run(process.execPath, [jsBin, ...full]);
      await settle();
      const js = server.take();

      if (JSON.stringify(go) !== JSON.stringify(js)) diffs.push({ args, go, js });
    }
  } finally {
    await server.close();
  }
  return { total: CASES.length, diffs };
}

// Only run the comparison when invoked deliberately (npm run test:*).
// `node --test` executes every file under test/, and an unguarded CLI block
// would run the harness as if it were a test and fail with exit 1.
if (process.env.QC_RUN_HARNESS === '1') {
  const { total, diffs } = await compareRequests();
  for (const d of diffs) {
    console.log(`=== ${JSON.stringify(d.args)}`);
    console.log(`  go: ${JSON.stringify(d.go)}`);
    console.log(`  js: ${JSON.stringify(d.js)}`);
  }
  console.log(`\nrequest scenarios: ${total}  divergences: ${diffs.length}`);
  process.exitCode = diffs.length === 0 ? 0 : 1;
}
