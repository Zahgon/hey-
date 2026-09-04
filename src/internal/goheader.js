// Port of net/http.Header and CanonicalHeaderKey.
//
//   G-HDR-1  Canonicalisation is conditional. Go only rewrites a key when EVERY
//            byte is a valid HTTP token character; otherwise the key is stored
//            verbatim. Probed on go1.26.7:
//              "content-type" -> "Content-Type"
//              "weird_key"    -> "Weird_key"   ('_' is a token char, not a
//                                                separator, so it does NOT
//                                                trigger the next-letter upcase)
//              "a-b_c"        -> "A-B_c"
//              "\u041a\u043b\u044e\u0447" -> unchanged (non-ASCII)
//            A naive "capitalise each dash-separated part" would produce
//            "Weird_Key" and would mangle the non-ASCII key.
//   G-HDR-2  Only bytes after a '-' (and the first byte) are upper-cased; every
//            other byte is lower-cased.

const isTokenChar = (() => {
  const table = new Uint8Array(128);
  const extra = "!#$%&'*+-.^_`|~";
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || extra.includes(ch)) {
      table[c] = 1;
    }
  }
  return (code) => code < 128 && table[code] === 1;
})();

/** http.CanonicalHeaderKey (G-HDR-1, G-HDR-2). */
export function canonicalHeaderKey(key) {
  for (let i = 0; i < key.length; i++) {
    if (!isTokenChar(key.charCodeAt(i))) return key;
  }
  let out = '';
  let upperNext = true;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    out += upperNext ? ch.toUpperCase() : ch.toLowerCase();
    upperNext = ch === '-';
  }
  return out;
}

/** net/http.Header — a canonical-key multimap preserving insertion order. */
export class Header extends Map {
  Set(key, value) {
    super.set(canonicalHeaderKey(key), [value]);
  }

  Add(key, value) {
    const k = canonicalHeaderKey(key);
    const existing = super.get(k);
    if (existing === undefined) super.set(k, [value]);
    else existing.push(value);
  }

  /** Header.Get returns "" when the key is absent, never undefined. */
  Get(key) {
    const values = super.get(canonicalHeaderKey(key));
    return values === undefined || values.length === 0 ? '' : values[0];
  }

  Del(key) {
    super.delete(canonicalHeaderKey(key));
  }
}
