// hey compiles exactly two regexps. Written literally in JavaScript they would
// both be WRONG, because Go's RE2 and JS RegExp disagree on two classes that
// these patterns depend on:
//
//   G-RE-1  `\s`.  RE2 (non-Unicode mode) is ASCII-only: [\t\n\f\r ].
//           JS `\s` additionally matches \v, NBSP, U+1680, U+2000-U+200A,
//           U+2028/9, U+202F, U+205F, U+3000 and U+FEFF.
//           Probed: Go `^\s$` rejects "\u00a0" and "\v"; JS accepts both.
//           This matters twice: `\s*` in headerRegexp and `[^\s]` in authRegexp
//           — and in the negated form the divergence flips an accept into a
//           reject, so a header value starting with NBSP would change meaning.
//   G-RE-2  `.`.   RE2 excludes only "\n". JS also excludes \r, U+2028, U+2029.
//           Probed: Go `^.$` MATCHES "\r"; JS does not.
//
// Both patterns are therefore respelled with explicit classes. The `u` flag is
// set so quantified `.` consumes a whole code point, matching RE2's
// rune-at-a-time semantics rather than UTF-16 code units.

/** RE2's ASCII `\s` (G-RE-1). */
export const RE2_SPACE = '[\\t\\n\\f\\r ]';
/** RE2's ASCII `\S`. */
export const RE2_NOT_SPACE = '[^\\t\\n\\f\\r ]';
/** RE2's `.` (G-RE-2). */
export const RE2_DOT = '[^\\n]';
/** RE2's ASCII `\w`. Identical to JS `\w`, spelled out so the intent is pinned. */
export const RE2_WORD = '[0-9A-Za-z_]';

/** Go: `^([\w-]+):\s*(.+)` */
export const headerRegexp = new RegExp(`^([0-9A-Za-z_-]+):${RE2_SPACE}*(${RE2_DOT}+)`, 'u');

/** Go: `^(.+):([^\s].+)` */
export const authRegexp = new RegExp(`^(${RE2_DOT}+):(${RE2_NOT_SPACE}${RE2_DOT}+)`, 'u');

/**
 * regexp.FindStringSubmatch.
 *
 * Go returns `nil` when there is no match and a slice whose element 0 is the
 * full match otherwise. Unmatched optional groups are "" in Go but `undefined`
 * in JS; neither pattern above has an optional group, but the normalisation is
 * applied anyway so the shape is Go's under any future edit.
 */
export function findStringSubmatch(re, input) {
  const m = re.exec(input);
  if (m === null) return null;
  return Array.from(m, (group) => (group === undefined ? '' : group));
}
