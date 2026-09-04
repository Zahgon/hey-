// Ordering rules that JavaScript does not provide by default.
//
//   G-SORT-1  sort.Float64s puts NaN FIRST. Its comparator is
//               x < y || (isNaN(x) && !isNaN(y))
//             A JS `(a, b) => a - b` comparator yields NaN for any NaN pair,
//             which the spec treats as "equal", leaving order implementation-
//             defined. report.go reads lats[0] and lats[len-1] straight out of
//             the sorted slice, so this is externally observable.
//   G-SORT-2  text/template `range` over a map is NOT insertion-ordered and NOT
//             locale-ordered. Go sorts the keys: numerically for integer keys,
//             by UTF-8 BYTES for string keys. Recorded probe:
//               map[int]int{500,200,404,100,-5} -> -5, 100, 200, 404, 500
//               map[string]int{"zeta","alpha","Beta",""} -> "", "Beta", "alpha", "zeta"
//             ("Beta" precedes "alpha" because 'B' is 0x42 and 'a' is 0x61.)
//             This drives hey's "Status code distribution" and "Error
//             distribution" sections, so it is part of the output contract.
//   G-SORT-3  String comparison is over UTF-8 bytes, not UTF-16 code units.
//             They diverge for any astral character vs. U+E000..U+FFFF:
//               UTF-8:  "\uFF01" (EF BC 81) < "\u{10000}" (F0 90 80 80)
//               UTF-16: "\u{10000}" (D800 DC00) < "\uFF01" (FF01)

const utf8 = new TextEncoder();

/** Compare two strings as Go does: lexicographically over their UTF-8 bytes (G-SORT-3). */
export function compareStringsUTF8(a, b) {
  if (a === b) return 0;
  const ba = utf8.encode(a);
  const bb = utf8.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
  }
  return ba.length === bb.length ? 0 : ba.length < bb.length ? -1 : 1;
}

/** sort.Strings — ascending UTF-8 byte order, in place. */
export function sortStrings(values) {
  values.sort(compareStringsUTF8);
  return values;
}

/** sort.Float64s — ascending with NaN first, in place (G-SORT-1). */
export function sortFloat64s(values) {
  values.sort((x, y) => {
    const xn = Number.isNaN(x);
    const yn = Number.isNaN(y);
    if (xn && yn) return 0;
    if (xn) return -1;
    if (yn) return 1;
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  });
  return values;
}

/** sort.Ints — ascending numeric, in place. */
export function sortInts(values) {
  values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return values;
}

/**
 * The key order text/template uses when ranging over a map (G-SORT-2).
 *
 * `map` is a JS Map. Integer-keyed maps sort numerically; string-keyed maps
 * sort by UTF-8 bytes.
 */
export function templateMapKeys(map) {
  const keys = [...map.keys()];
  if (keys.every((k) => typeof k === 'number')) return sortInts(keys);
  if (keys.every((k) => typeof k === 'string')) return sortStrings(keys);
  if (keys.length === 0) return keys;
  throw new TypeError('templateMapKeys: mixed or unsupported key types');
}
