// Go value semantics needed by text/template: the `%v` rendering used to print
// a bare action, plus truthiness and ordered comparison.
//
//   G-TMPL-1  `%v` on a float64 is `%g` with shortest round-trip digits and an
//             exponent-vs-positional decision made at eprec = 6:
//                 exp < -4 || exp >= 6  ->  exponent form
//             Probed: 100000 -> "100000" but 123456789 -> "1.23456789e+08",
//             1e-5 -> "1e-05" but 0.0001234 -> "0.0001234".
//             JS String() would print "0.00001" and "123456789" — both wrong.
//   G-TMPL-2  A nil / missing value renders as the literal "<no value>", and
//             doing so is NOT an execution error.
//   G-TMPL-3  Maps render sorted: "map[a:1 b:2]". Slices render "[1 2.5]".
//   G-TMPL-4  Go's `int`/`int64` and `float64` are DIFFERENT types and %v
//             renders them differently: the float64 123456789 prints as
//             "1.23456789e+08" while the int 123456789 prints as "123456789".
//             JavaScript has one numeric type, so the distinction is carried in
//             the representation instead:
//                 Go int / int64 / uint...  ->  BigInt
//                 Go float64                ->  JS number
//             This is not bookkeeping for its own sake. It also forces Go's
//             INTEGER division at the three places report.go/print.go rely on
//             it — `sizeTotal / len(lats)`, `i * 100 / len(lats)` and
//             `(count*40 + max/2) / max` — each of which would silently become
//             a fractional result under JS `/`.

import { templateMapKeys, compareStringsUTF8 } from '../gosort.js';

/** Marker for Go's untyped nil / absent field (G-TMPL-2). */
export const NO_VALUE = Symbol('go:<no value>');

/**
 * Marks a nil map/slice as opposed to an empty one (G-TMPL-5).
 *
 * Go distinguishes `var m map[K]V` from `map[K]V{}`, and the difference is
 * observable through exactly one channel: json.Marshal renders nil as `null`
 * and empty as `{}` / `[]`. Under %v, len() and range they are identical
 * ("map[]", "[]", 0, no iterations). report.snapshot() returns nil
 * StatusCodeDist / Histogram / LatencyDistribution whenever there are no
 * successful results, so `hey -o '{{ jsonify .StatusCodeDist }}'` prints
 * "null" on an all-error run.
 */
export const IS_NIL = Symbol('go:nil');

/** An empty slice that reports as Go's nil slice. */
export function nilSlice() {
  const a = [];
  a[IS_NIL] = true;
  return a;
}

/** An empty map that reports as Go's nil map. */
export function nilMap() {
  const m = new Map();
  m[IS_NIL] = true;
  return m;
}

/** A time.Duration exposed to templates, so `.Total.Seconds` resolves. */
export class GoDuration {
  constructor(nanoseconds) {
    this.nanoseconds = BigInt(nanoseconds);
  }

  /** time.Duration.Seconds() — split arithmetic, matching goduration.seconds. */
  Seconds() {
    const sec = this.nanoseconds / 1000000000n;
    const nsec = this.nanoseconds % 1000000000n;
    return Number(sec) + Number(nsec) / 1e9;
  }

  /** time.Duration.String() — "1h30m0s", "1.5s", "100ms", "0s". */
  String() {
    let ns = this.nanoseconds;
    if (ns === 0n) return '0s';
    const sign = ns < 0n ? '-' : '';
    if (ns < 0n) ns = -ns;

    if (ns < 1000n) return `${sign}${ns}ns`;
    if (ns < 1000000n) return `${sign}${trimZeros(ns, 1000n)}\u00b5s`;
    if (ns < 1000000000n) return `${sign}${trimZeros(ns, 1000000n)}ms`;

    const totalSeconds = ns / 1000000000n;
    const fraction = trimZeros(ns % 1000000000n + 1000000000n, 1000000000n).slice(1);
    const hours = totalSeconds / 3600n;
    const minutes = (totalSeconds % 3600n) / 60n;
    const secs = totalSeconds % 60n;
    let out = `${secs}${fraction}s`;
    if (hours > 0n || minutes > 0n) out = `${minutes}m${out}`;
    if (hours > 0n) out = `${hours}h${out}`;
    return sign + out;
  }
}

function trimZeros(value, unit) {
  const whole = value / unit;
  const frac = (value % unit).toString().padStart(unit.toString().length - 1, '0').replace(/0+$/u, '');
  return frac === '' ? `${whole}` : `${whole}.${frac}`;
}

/** strconv.FormatFloat(f, 'g', -1, 64) as used by `%v` (G-TMPL-1). */
export function formatFloatG(f) {
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';

  const negative = f < 0;
  const abs = Math.abs(f);

  // toExponential() with no argument yields the shortest uniquely-identifying
  // digit string — the same digits Go's shortest conversion produces.
  const sci = abs.toExponential(); // "d[.ddd]e±k"
  const [mantissa, expPart] = sci.split('e');
  const exp = Number(expPart);
  const digits = mantissa.replace('.', '');

  let body;
  if (exp < -4 || exp >= 6) {
    // Exponent form; Go pads the exponent to at least two digits.
    const sign = exp < 0 ? '-' : '+';
    const magnitude = String(Math.abs(exp)).padStart(2, '0');
    body = `${mantissa}e${sign}${magnitude}`;
  } else if (exp >= 0) {
    if (digits.length <= exp + 1) {
      body = digits.padEnd(exp + 1, '0');
    } else {
      body = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
    }
  } else {
    body = `0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  return negative ? `-${body}` : body;
}

/** fmt's `%v` for the value kinds a hey template can hold (G-TMPL-1..4). */
export function formatV(value) {
  if (value === NO_VALUE || value === null || value === undefined) return '<no value>';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return formatFloatG(value);
  if (value instanceof GoDuration) return value.String();
  if (Array.isArray(value)) return `[${value.map(formatV).join(' ')}]`;
  if (value instanceof Map) {
    const keys = templateMapKeys(value);
    return `map[${keys.map((k) => `${formatV(k)}:${formatV(value.get(k))}`).join(' ')}]`;
  }
  if (typeof value === 'object') {
    // A struct renders as its space-separated field values.
    return `{${Object.values(value).map(formatV).join(' ')}}`;
  }
  return String(value);
}

/**
 * Go template truth: false, 0, nil, and empty string/slice/map are all false.
 * NaN is TRUE, because Go evaluates `val.Float() != 0`.
 */
export function isTrue(value) {
  if (value === NO_VALUE || value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (value instanceof GoDuration) return value.nanoseconds !== 0n;
  return true;
}

/** Numeric/string comparison backing eq/ne/lt/le/gt/ge. */
export function compareValues(a, b) {
  const an = toComparableNumber(a);
  const bn = toComparableNumber(b);
  if (an !== null && bn !== null) {
    // Compare in BigInt when both are integral to keep int64 exactness.
    if (typeof an === 'bigint' && typeof bn === 'bigint') {
      return an < bn ? -1 : an > bn ? 1 : 0;
    }
    const af = typeof an === 'bigint' ? Number(an) : an;
    const bf = typeof bn === 'bigint' ? Number(bn) : bn;
    if (Number.isNaN(af) || Number.isNaN(bf)) return NaN;
    return af < bf ? -1 : af > bf ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    // Go compares strings as UTF-8 bytes, not UTF-16 code units (G-SORT-3).
    return compareStringsUTF8(a, b);
  }
  throw new Error('incompatible types for comparison');
}

function toComparableNumber(v) {
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  return null;
}
