// Port of time.Duration and time.ParseDuration.
//
// A Go Duration is an int64 nanosecond count. Representing it as a JS `number`
// would silently lose precision above 2**53 ns (~104 days) and, more
// importantly, would make Seconds() disagree with Go in the last bits. All
// durations here are therefore BigInt nanoseconds.
//
//   G-DUR-1  Seconds() is NOT `ns / 1e9`. Go splits the value first:
//              sec := d / Second; nsec := d % Second
//              return float64(sec) + float64(nsec)/1e9
//            which is a different (and differently-rounded) float expression.
//   G-DUR-2  ParseDuration accepts "1.5s", "1h30m", "µs"/"μs"/"us", a leading
//            sign, and the bare "0" — but rejects "10" (missing unit) and "1d".
//            Its three error messages are user-visible through hey's CLI.

export const NANOSECOND = 1n;
export const MICROSECOND = 1000n;
export const MILLISECOND = 1000000n;
export const SECOND = 1000000000n;
export const MINUTE = 60n * SECOND;
export const HOUR = 60n * MINUTE;

const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

/** time.Duration.Seconds() — reproduces Go's split computation exactly (G-DUR-1). */
export function seconds(d) {
  const sec = d / SECOND; // BigInt division truncates toward zero, like Go
  const nsec = d % SECOND;
  return Number(sec) + Number(nsec) / 1e9;
}

const UNITS = new Map([
  ['ns', NANOSECOND],
  ['us', MICROSECOND],
  ['\u00b5s', MICROSECOND], // U+00B5 MICRO SIGN
  ['\u03bcs', MICROSECOND], // U+03BC GREEK SMALL LETTER MU
  ['ms', MILLISECOND],
  ['s', SECOND],
  ['m', MINUTE],
  ['h', HOUR],
]);

/**
 * time.ParseDuration. Returns BigInt nanoseconds; throws an Error whose message
 * is byte-identical to Go's for every rejection path (G-DUR-2).
 */
export function parseDuration(input) {
  const orig = input;
  let s = input;
  let neg = false;

  if (s.startsWith('+') || s.startsWith('-')) {
    neg = s[0] === '-';
    s = s.slice(1);
  }

  // Special case: "0" (and only "0") needs no unit.
  if (s === '0') return 0n;
  if (s === '') throw invalid(orig);

  let total = 0n;
  while (s !== '') {
    // Each iteration consumes one [digits][.digits]<unit> group.
    if (!(s[0] === '.' || (s[0] >= '0' && s[0] <= '9'))) throw invalid(orig);

    const intStart = s.length;
    let whole = 0n;
    let i = 0;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') {
      whole = whole * 10n + BigInt(s.charCodeAt(i) - 48);
      if (whole > INT64_MAX) throw invalid(orig); // Go: overflow -> "invalid duration"
      i++;
    }
    const sawInt = i > 0;
    s = s.slice(i);

    // Optional fraction.
    let fracValue = 0n;
    let fracScale = 1n;
    let sawFrac = false;
    if (s !== '' && s[0] === '.') {
      s = s.slice(1);
      let j = 0;
      while (j < s.length && s[j] >= '0' && s[j] <= '9') {
        if (fracScale < 10n ** 18n) {
          fracValue = fracValue * 10n + BigInt(s.charCodeAt(j) - 48);
          fracScale *= 10n;
        }
        j++;
      }
      sawFrac = j > 0;
      s = s.slice(j);
    }
    void intStart;
    if (!sawInt && !sawFrac) throw invalid(orig);

    // Unit.
    let u = 0;
    while (u < s.length && s[u] !== '.' && !(s[u] >= '0' && s[u] <= '9')) u++;
    if (u === 0) throw new Error(`time: missing unit in duration ${quoteGo(orig)}`);
    const unitText = s.slice(0, u);
    s = s.slice(u);
    const unit = UNITS.get(unitText);
    if (unit === undefined) {
      throw new Error(`time: unknown unit ${quoteGo(unitText)} in duration ${quoteGo(orig)}`);
    }

    let value = whole * unit;
    if (value / unit !== whole) throw invalid(orig);
    if (sawFrac) value += (fracValue * unit) / fracScale;
    total += value;
    if (total > INT64_MAX) throw invalid(orig);
  }

  if (neg) total = -total;
  if (total > INT64_MAX || total < INT64_MIN) throw invalid(orig);
  return total;
}

function invalid(orig) {
  return new Error(`time: invalid duration ${quoteGo(orig)}`);
}

/** Go's %q for the ASCII-safe strings that reach these error messages. */
function quoteGo(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}
