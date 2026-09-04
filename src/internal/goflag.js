// Port of Go's `flag` package, limited to the flag kinds hey declares.
//
// Node's util.parseArgs cannot stand in for this:
//
//   G-FLAG-1  Go STOPS at the first non-flag argument. `hey -n 5 http://x -o`
//             leaves "-o" as a positional, it does not parse it as a flag.
//             parseArgs has no such mode.
//   G-FLAG-2  A bool flag never consumes the next argument. `-h2 true http://x`
//             sets h2=true and leaves "true" as the FIRST positional, so the
//             URL becomes "true". Probed: exit status 0.
//   G-FLAG-3  Single and double dash are equivalent: `-n` == `--n`.
//   G-FLAG-4  Error text and exit codes are observable:
//               unknown flag  -> "flag provided but not defined: -badflag",
//                                usage on stderr, exit 2
//               bad value     -> `invalid value "abc" for flag -n: parse error`,
//                                usage on stderr, exit 2
//               -help/-h when undefined -> usage, exit 0
//             Every numeric/duration parse failure is flattened to the literal
//             string "parse error", because flag's *Value.Set replaces the
//             underlying strconv/time error with errParse.
//   G-FLAG-5  "--" terminates flag parsing; the remainder is positional.

import { parseDuration } from './goduration.js';

export class ErrHelp extends Error {}
export class FlagError extends Error {}

const INT_MIN = -(2n ** 63n);
const INT_MAX = 2n ** 63n - 1n;

export class FlagSet {
  constructor(name) {
    this.name = name;
    this.formal = new Map();
    this.actual = new Map();
    this.args = [];
    this.Usage = null;
  }

  String(name, value) {
    return this.define(name, 'string', value);
  }

  Int(name, value) {
    return this.define(name, 'int', value);
  }

  Float64(name, value) {
    return this.define(name, 'float64', value);
  }

  Bool(name, value) {
    return this.define(name, 'bool', value);
  }

  Duration(name, value) {
    return this.define(name, 'duration', value);
  }

  /** flag.Var — a custom Value with its own Set(string). */
  Var(value, name) {
    this.formal.set(name, { name, kind: 'var', value });
    return value;
  }

  define(name, kind, defaultValue) {
    const holder = { value: defaultValue };
    this.formal.set(name, { name, kind, holder });
    return holder;
  }

  /** flag.Args() — the positional arguments after parsing stopped. */
  Args() {
    return this.args;
  }

  NArg() {
    return this.args.length;
  }

  /**
   * flag.Parse. Returns normally on success; throws ErrHelp for -help and
   * FlagError for a usage error. The caller maps those to exit codes.
   */
  parse(argv) {
    let rest = [...argv];
    for (;;) {
      const outcome = this.parseOne(rest);
      rest = outcome.rest;
      if (outcome.stop) break;
    }
    this.args = rest;
  }

  /**
   * One iteration of Go's parseOne. Returns { rest, stop }; `stop` marks the
   * end of flag parsing, which Go signals by returning false with a nil error.
   */
  parseOne(argv) {
    if (argv.length === 0) return { rest: argv, stop: true };
    const s = argv[0];
    // G-FLAG-1: anything that is not "-x" ends flag parsing.
    if (s.length < 2 || s[0] !== '-') return { rest: argv, stop: true };

    let name = s.slice(1);
    if (name[0] === '-') {
      // G-FLAG-3
      name = name.slice(1);
      // G-FLAG-5: a bare "--" terminates; the rest is positional.
      if (name === '') return { rest: argv.slice(1), stop: true };
    }
    if (name === '' || name[0] === '-' || name[0] === '=') {
      // Go routes this through failf, which prints to stderr AND prints usage.
      throw this.failf(`bad flag syntax: ${s}`);
    }

    let rest = argv.slice(1);
    let hasValue = false;
    let value = '';
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      hasValue = true;
      name = name.slice(0, eq);
    }

    const flag = this.formal.get(name);
    if (flag === undefined) {
      if (name === 'help' || name === 'h') {
        this.usage();
        throw new ErrHelp('flag: help requested');
      }
      // Go always reports a single dash here, regardless of how it was written.
      throw this.failf(`flag provided but not defined: -${name}`);
    }

    if (flag.kind === 'bool' && !hasValue) {
      // G-FLAG-2: bool flags never take the following argument.
      flag.holder.value = true;
      this.actual.set(name, flag);
      return { rest, stop: false };
    }

    if (!hasValue) {
      if (rest.length === 0) {
        throw this.failf(`flag needs an argument: -${name}`);
      }
      value = rest[0];
      rest = rest.slice(1);
    }

    this.setValue(flag, name, value);
    this.actual.set(name, flag);
    return { rest, stop: false };
  }

  setValue(flag, name, raw) {
    const bad = () => this.failf(`invalid value ${quote(raw)} for flag -${name}: parse error`);
    switch (flag.kind) {
      case 'string':
        flag.holder.value = raw;
        return;
      case 'bool': {
        const truthy = ['1', 't', 'T', 'true', 'TRUE', 'True'];
        const falsy = ['0', 'f', 'F', 'false', 'FALSE', 'False'];
        if (truthy.includes(raw)) flag.holder.value = true;
        else if (falsy.includes(raw)) flag.holder.value = false;
        else throw bad();
        return;
      }
      case 'int': {
        // flag.Int uses strconv.ParseInt(s, 0, 64) -- BASE 0, so it honours
        // 0x/0b/0o prefixes, bare leading-zero OCTAL and `_` separators.
        // Decimal-only parsing silently changes `-n 010` from 8 to 10.
        const v = parseIntBase0(raw);
        if (v === null) throw bad();
        if (v < INT_MIN || v > INT_MAX) {
          throw this.failf(`invalid value ${quote(raw)} for flag -${name}: value out of range`);
        }
        flag.holder.value = Number(v);
        return;
      }
      case 'float64': {
        if (!/^[+-]?((\d+(\.\d*)?)|(\.\d+))([eE][+-]?\d+)?$/u.test(raw) && !/^[+-]?(inf|infinity|nan)$/iu.test(raw)) {
          throw bad();
        }
        flag.holder.value = Number(raw);
        return;
      }
      case 'duration': {
        try {
          flag.holder.value = parseDuration(raw);
        } catch {
          // G-FLAG-4: durationValue.Set discards the real error text.
          throw bad();
        }
        return;
      }
      case 'var':
        flag.value.Set(raw);
        return;
      default:
        throw new Error(`unknown flag kind ${flag.kind}`);
    }
  }

  usage() {
    if (this.Usage !== null) this.Usage();
  }

  failf(message) {
    process.stderr.write(`${message}\n`);
    this.usage();
    const err = new FlagError(message);
    return err;
  }
}

/** strconv.ParseInt(s, 0, 64) — returns null when Go would report a parse error. */
function parseIntBase0(raw) {
  let s = raw;
  let sign = 1n;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) { sign = -1n; s = s.slice(1); }
  if (s === '') return null;

  let base = 10n;
  let digits = s;
  const prefix = s.slice(0, 2).toLowerCase();
  if (prefix === '0x') { base = 16n; digits = s.slice(2); }
  else if (prefix === '0b') { base = 2n; digits = s.slice(2); }
  else if (prefix === '0o') { base = 8n; digits = s.slice(2); }
  else if (s.length > 1 && s[0] === '0') { base = 8n; digits = s.slice(1); }

  if (digits === '' || digits.startsWith('_') || digits.endsWith('_')) return null;
  if (digits.includes('__')) return null;

  let value = 0n;
  let sawDigit = false;
  if (digits.length > 4096) return null;
  for (const ch of digits) {
    if (ch === '_') continue;
    const parsed = parseInt(ch, 36);
    if (Number.isNaN(parsed) || BigInt(parsed) >= base) return null;
    value = value * base + BigInt(parsed);
    sawDigit = true;
  }
  // Range is checked by the caller so it can report Go's distinct
  // "value out of range" message instead of "parse error".
  return sawDigit ? sign * value : null;
}

/** strconv.Quote for the ASCII-ish values that reach flag error messages. */
function quote(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\x07') out += '\\a';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\v') out += '\\v';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}
