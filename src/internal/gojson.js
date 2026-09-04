// Port of encoding/json's Marshal for the value kinds hey's `jsonify` template
// helper can receive. JSON.stringify is not a substitute:
//
//   G-JSON-1  Go's default encoder HTML-escapes `<`, `>` and `&` into
//             \u003c, \u003e, \u0026, and also escapes U+2028/U+2029.
//             JSON.stringify leaves all five alone.
//   G-JSON-2  Go switches a float64 to exponent form at abs < 1e-6 or
//             abs >= 1e21, then rewrites "e-09" to "e-9". JSON.stringify
//             switches at 1e-7 / 1e21 and keeps two-digit exponents.
//               Go: 1e-7 -> "1e-7"      JSON.stringify -> "1e-7"
//               Go: 1e-6 -> "0.000001"  JSON.stringify -> "0.000001"
//               Go: 1e-21 -> "1e-21"    JSON.stringify -> "1e-21"
//             The rewrite step is the visible one: Go emits "1e-9", JS "1e-9"
//             only because it never pads — but Go's 'e' formatting of e.g.
//             1e100 gives "1e+100" where JSON.stringify gives "1e+100" too.
//             The genuinely divergent band is 1e-7 <= abs < 1e-6.
//   G-JSON-3  Map keys are emitted in sorted order; JS object key order would
//             be insertion order.
//   G-JSON-4  NaN and +/-Inf are a marshalling ERROR in Go, not `null`.
//             jsonify discards that error and returns "", since print.go writes
//             `d, _ := json.Marshal(v)`.

import { templateMapKeys, compareStringsUTF8 } from './gosort.js';
import { NO_VALUE, GoDuration, IS_NIL } from './gotemplate/value.js';

class UnsupportedValueError extends Error {}

/**
 * print.go's `jsonify`: `d, _ := json.Marshal(v); return string(d)`.
 * The error is deliberately swallowed, exactly as upstream does (G-JSON-4).
 */
export function marshalJSON(value) {
  try {
    return encode(value);
  } catch (err) {
    if (err instanceof UnsupportedValueError) return '';
    throw err;
  }
}

function encode(value) {
  if (value === NO_VALUE || value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return encodeFloat(value);
  if (value instanceof GoDuration) return value.nanoseconds.toString();
  // A nil map/slice marshals to `null`, an empty one to `{}` / `[]` (G-TMPL-5).
  if (value[IS_NIL] === true) return 'null';
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (value instanceof Map) {
    const keys = templateMapKeys(value);
    return `{${keys.map((k) => `${encodeString(String(k))}:${encode(value.get(k))}`).join(',')}}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => typeof value[k] !== 'function');
    return `{${keys.map((k) => `${encodeString(k)}:${encode(value[k])}`).join(',')}}`;
  }
  throw new UnsupportedValueError(`json: unsupported type: ${typeof value}`);
}

/** encoding/json string encoding, including the HTML escapes (G-JSON-1). */
function encodeString(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '<':
        out += '\\u003c';
        continue;
      case '>':
        out += '\\u003e';
        continue;
      case '&':
        out += '\\u0026';
        continue;
      case '\u2028':
        out += '\\u2028';
        continue;
      case '\u2029':
        out += '\\u2029';
        continue;
      default:
        break;
    }
    out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return `${out}"`;
}

/** encoding/json float64 encoding (G-JSON-2, G-JSON-4). */
function encodeFloat(f) {
  if (Number.isNaN(f) || f === Infinity || f === -Infinity) {
    throw new UnsupportedValueError(`json: unsupported value: ${f}`);
  }
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';

  const abs = Math.abs(f);
  const useExponent = abs < 1e-6 || abs >= 1e21;
  let text = useExponent ? shortestExponential(f) : shortestPositional(f);

  if (useExponent) {
    // Go rewrites a two-digit negative exponent with a leading zero: e-09 -> e-9.
    text = text.replace(/e-0(\d)$/u, 'e-$1');
  }
  return text;
}

function shortestExponential(f) {
  const sci = Math.abs(f).toExponential();
  const [mantissa, expPart] = sci.split('e');
  const exp = Number(expPart);
  const sign = exp < 0 ? '-' : '+';
  const body = `${mantissa}e${sign}${Math.abs(exp)}`;
  return f < 0 ? `-${body}` : body;
}

function shortestPositional(f) {
  const negative = f < 0;
  const sci = Math.abs(f).toExponential();
  const [mantissa, expPart] = sci.split('e');
  const exp = Number(expPart);
  const digits = mantissa.replace('.', '');

  let body;
  if (exp >= 0) {
    body = digits.length <= exp + 1
      ? digits.padEnd(exp + 1, '0')
      : `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  } else {
    body = `0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  return negative ? `-${body}` : body;
}

export { compareStringsUTF8 };
