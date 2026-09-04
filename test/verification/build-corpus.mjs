// Builds verification/corpus.json — the shared input for the Go and JS report
// drivers. Deterministic (seeded PRNG) so the baseline is reproducible.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// xorshift128+, seeded — Math.random() would make the baseline unreproducible.
function makeRandom(seed) {
  let s0 = seed >>> 0 || 1;
  let s1 = (seed * 2654435761) >>> 0 || 2;
  return () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= x << 23;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26);
    s1 = x >>> 0;
    return ((s0 + s1) >>> 0) / 4294967296;
  };
}

const rand = makeRandom(20240607);

const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const STATUS_CODES = [200, 200, 200, 201, 204, 301, 302, 400, 404, 429, 500, 502, 503, 0];
const ERRORS = [
  '',
  '',
  '',
  '',
  'Get "http://x": dial tcp: connection refused',
  'Get "http://x": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  'Get "http://x": EOF',
  'net/http: request canceled',
  // Keys that would be hazardous in a plain JS object accumulator.
  '__proto__',
  'constructor',
  'toString',
  // Ordering-sensitive keys: uppercase sorts before lowercase in UTF-8.
  'Zeta',
  'alpha',
  '\u00e9rror',
  '\u{10000}astral',
];

const OUTPUTS = [
  '',
  '',
  '',
  'csv',
  'csv',
  '{{ .NumRes }}|{{ .SizeTotal }}|{{ .SizeReq }}',
  '{{ formatNumber .Average }} {{ formatNumber .Rps }} {{ formatNumber .Fastest }}',
  '{{ range $c, $n := .StatusCodeDist }}{{$c}}={{$n}};{{ end }}',
  '{{ range $e, $n := .ErrorDist }}{{$e}}#{{$n}};{{ end }}',
  '{{ histogram .Histogram }}',
  '{{ range .LatencyDistribution }}{{ .Percentage }}:{{ formatNumber .Latency }},{{ end }}',
  '{{ if gt .SizeTotal 0 }}BIG{{ else }}SMALL{{ end }}',
  '{{ len .Lats }}/{{ len .ErrorDist }}',
  '{{ .Total.Seconds }}',
  '{{ .Slowest }} {{ .Average }} {{ .Rps }}',
  '{{ jsonify .StatusCodeDist }}',
  '{{ jsonify .ErrorDist }}',
  '{{ $l := .Lats }}{{ range $i, $v := $l }}{{ $i }}:{{ formatNumber $v }} {{ end }}',
  '{{ index .Lats 0 }}',
  '{{ formatNumberInt (index .StatusCodes 0) }}',
];

// Latency magnitudes chosen to exercise the histogram bucketing and the
// %4.4f / %4.3f rounding boundaries, including exact binary ties.
function latencyNs() {
  const bucket = rand();
  if (bucket < 0.1) return 0;
  if (bucket < 0.2) return int(1, 1000);
  if (bucket < 0.5) return int(1000, 5_000_000);
  if (bucket < 0.8) return int(5_000_000, 500_000_000);
  if (bucket < 0.95) return int(500_000_000, 30_000_000_000);
  return int(0, 2 ** 31) * 1000;
}

function makeResult() {
  const err = pick(ERRORS);
  return {
    err,
    statusCode: err === '' ? pick(STATUS_CODES) : 0,
    offsetNs: latencyNs(),
    durationNs: latencyNs(),
    connNs: latencyNs(),
    dnsNs: latencyNs(),
    reqNs: latencyNs(),
    resNs: latencyNs(),
    delayNs: latencyNs(),
    contentLength: pick([-1, 0, 1, 512, 4096, 1048576, 9007199254740993]),
  };
}

const jobs = [];

// Hand-written edge cases first, so a failure names something meaningful.
jobs.push({ output: '', totalNs: 0, n: 0, results: [] });
jobs.push({ output: 'csv', totalNs: 0, n: 0, results: [] });
jobs.push({ output: '', totalNs: 1_000_000_000, n: 1, results: [] });
jobs.push({
  // All-error run: every average becomes 0/0 -> NaN, printed as " NaN".
  output: '',
  totalNs: 1_000_000_000,
  n: 2,
  results: [
    { err: 'boom', statusCode: 0, offsetNs: 0, durationNs: 0, connNs: 0, dnsNs: 0, reqNs: 0, resNs: 0, delayNs: 0, contentLength: 0 },
    { err: 'boom', statusCode: 0, offsetNs: 0, durationNs: 0, connNs: 0, dnsNs: 0, reqNs: 0, resNs: 0, delayNs: 0, contentLength: 0 },
  ],
});
jobs.push({
  // Single success: slowest == fastest, so the histogram bucket size is 0.
  output: '',
  totalNs: 1_000_000_000,
  n: 1,
  results: [
    { err: '', statusCode: 200, offsetNs: 0, durationNs: 62_500_000, connNs: 0, dnsNs: 0, reqNs: 0, resNs: 0, delayNs: 0, contentLength: 100 },
  ],
});
jobs.push({
  // totalNs == 0 with results -> Rps is a division by zero -> +Inf.
  output: '',
  totalNs: 0,
  n: 1,
  results: [
    { err: '', statusCode: 200, offsetNs: 0, durationNs: 1, connNs: 0, dnsNs: 0, reqNs: 0, resNs: 0, delayNs: 0, contentLength: 0 },
  ],
});
jobs.push({
  // Prototype-pollution shaped error keys.
  output: '',
  totalNs: 1_000_000_000,
  n: 3,
  results: ['__proto__', 'constructor', 'toString', '__proto__'].map((e) => ({
    err: e, statusCode: 0, offsetNs: 0, durationNs: 0, connNs: 0, dnsNs: 0, reqNs: 0, resNs: 0, delayNs: 0, contentLength: 0,
  })),
});

for (const output of OUTPUTS) {
  for (let n = 0; n < 30; n++) {
    const count = pick([0, 1, 2, 3, 5, 8, 11, 20, 37, 100, 199]);
    jobs.push({
      output,
      totalNs: pick([0, 1, 1_000_000, 1_000_000_000, 3_500_000_000, 60_000_000_000]),
      n: count,
      results: Array.from({ length: count }, makeResult),
    });
  }
}

if (process.env.QC_RUN_HARNESS === '1') {
  writeFileSync(join(here, 'corpus.json'), `${JSON.stringify(jobs)}\n`);
}
if (process.env.QC_RUN_HARNESS === '1') console.log(`corpus.json: ${jobs.length} jobs, ${jobs.reduce((a, j) => a + j.results.length, 0)} results`);
