// Diffs this port's CLI against the COMPILED Go binary on every argument
// combination whose output is deterministic (validation errors, usage, flag
// errors). Success paths are excluded here because they embed live timings;
// those are covered by the report differential instead.
//
// Usage: HEY_REF=/path/to/hey node verification/cli-diff.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const jsBin = join(here, '..', '..', 'bin', 'hey.js');
const goBin = process.env.HEY_REF ?? '/tmp/hey-ref';

const scratch = mkdtempSync(join(tmpdir(), 'heycli-'));
const bodyFile = join(scratch, 'body.txt');
writeFileSync(bodyFile, 'hello body');

export const SCENARIOS = [
  [],
  ['-n', '5'],
  ['-c', '0', 'http://x'],
  ['-n', '0', 'http://x'],
  ['-n', '1', '-c', '5', 'http://x'],
  ['-n', '-3', 'http://x'],
  ['-c', '-1', 'http://x'],
  ['-z', '10s', '-c', '0', 'http://x'],
  ['-z', '10s', '-c', '-1', 'http://x'],
  ['-h', 'foo', 'http://x'],
  ['-badflag', 'http://x'],
  ['--badflag', 'http://x'],
  ['-n', 'abc', 'http://x'],
  ['-n', '', 'http://x'],
  ['-z', 'bogus', 'http://x'],
  ['-z', '1d', 'http://x'],
  ['-q', 'x', 'http://x'],
  ['-t', '1.5', 'http://x'],
  ['-cpus', 'zzz', 'http://x'],
  ['-a', 'nocolon', 'http://x'],
  ['-a', 'a:b', 'http://x'],
  ['-a', 'user: pw', 'http://x'],
  ['-H', 'bad-input|x', 'http://x'],
  ['-H', 'X|oh|bad: v', 'http://x'],
  ['-H', '\u041a\u043b\u044e\u0447: v', 'http://x'],
  ['-x', '://bad', 'http://x'],
  ['-m', 'BAD METHOD', 'http://x'],
  ['-m', 'get', '-n', '0', 'http://x'],
  ['-D', '/nonexistent/file', 'http://x'],
  ['-D', scratch, 'http://x'],
  ['-help'],
  ['-n'],
  ['-o'],
  ['-n', '5', '-c', '10', 'http://x'],
  ['-n=5', '-c=10', 'http://x'],
  ['--n=5', '--c=10', 'http://x'],
  ['-z', '0', '-n', '0', 'http://x'],
];

// Scenarios that reach the load-generator and therefore print live timings on
// stdout. Only the exit code and stderr are comparable for these.
export const SUCCESS_SCENARIOS = [
  // G-FLAG-1/G-FLAG-2: -h2 is boolean, so "true" is the first POSITIONAL and
  // flag parsing stops there -- -n/-c are never parsed and keep their defaults.
  ['-h2', 'true', '-n', '1', '-c', '2', 'http://x'],
  ['://bad'],
  ['-n', '010', '-c', '1', 'http://x'],
  ['-n', '0x10', '-c', '1', 'http://x'],
  ['-n', '1_0', '-c', '1', 'http://x'],
  ['-n', '09', 'http://x'],
  ['---n', '5', 'http://x'],
  ['-=5', 'http://x'],
  ['-m', '\u00df', 'http://x'],
  ['-n', '1', '-c', '1', 'http://127.0.0.1:9/'],
];

// Go's panic writes the message AND a goroutine stack dump. Reproducing a Go
// runtime stack trace is neither possible nor useful, so for these the exit
// code and the `panic: ...` line are compared and the dump is not.
export const PANIC_SCENARIOS = [
  ['-n', '1', '-c', '1', '-o', '{{', 'http://127.0.0.1:9/'],
  ['-o', '{{ nosuchfunc . }}', 'http://127.0.0.1:9/'],
];

function run(cmd, args) {
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, GOMAXPROCS: '' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function compareAll() {
  const diffs = [];
  for (const args of SCENARIOS) {
    const go = run([goBin], args);
    const js = run([process.execPath, jsBin], args);
    if (go.status !== js.status || go.stderr !== js.stderr || go.stdout !== js.stdout) {
      diffs.push({ args, go, js });
    }
  }
  for (const args of SUCCESS_SCENARIOS) {
    const go = run([goBin], args);
    const js = run([process.execPath, jsBin], args);
    if (go.status !== js.status || go.stderr !== js.stderr) {
      diffs.push({ args, go, js });
    }
  }
  for (const args of PANIC_SCENARIOS) {
    const go = run([goBin], args);
    const js = run([process.execPath, jsBin], args);
    const firstLine = (t) => t.split('\n')[0];
    if (go.status !== js.status || firstLine(go.stderr) !== firstLine(js.stderr)) {
      diffs.push({ args, go, js });
    }
  }
  return {
    total: SCENARIOS.length + SUCCESS_SCENARIOS.length + PANIC_SCENARIOS.length,
    diffs,
  };
}

// Only run the comparison when invoked deliberately (npm run test:*).
// `node --test` executes every file under test/, and an unguarded CLI block
// would run the harness as if it were a test and fail with exit 1.
if (process.env.QC_RUN_HARNESS === '1') {
  const { total, diffs } = compareAll();
  for (const d of diffs) {
    console.log(`=== ${JSON.stringify(d.args)}`);
    console.log(`  go: exit=${d.go.status} stderr=${JSON.stringify(d.go.stderr.slice(0, 200))}`);
    console.log(`  js: exit=${d.js.status} stderr=${JSON.stringify(d.js.stderr.slice(0, 200))}`);
  }
  console.log(`\nscenarios: ${total}  divergences: ${diffs.length}`);
  process.exitCode = diffs.length === 0 ? 0 : 1;
}
