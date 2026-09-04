// text/template execution over the AST produced by parse.js.

import { NodeType, parse } from './parse.js';
import { NO_VALUE, GoDuration, formatV, isTrue, compareValues } from './value.js';
import { formatF } from '../gofmt.js';
import { templateMapKeys } from '../gosort.js';

class ExecError extends Error {}

class Scope {
  constructor(dot, vars) {
    this.dot = dot;
    this.vars = vars;
  }

  child(dot) {
    return new Scope(dot, new Map(this.vars));
  }
}

/** A parsed template, mirroring *template.Template. */
export class Template {
  constructor(name, root, funcs) {
    this.name = name;
    this.root = root;
    this.funcs = funcs;
  }

  /** template.Execute — returns the rendered string. */
  execute(data) {
    const out = [];
    this.walk(this.root, new Scope(data, new Map()), out);
    return out.join('');
  }

  walk(node, scope, out) {
    switch (node.type) {
      case NodeType.LIST:
        for (const child of node.nodes) this.walk(child, scope, out);
        return;
      case NodeType.TEXT:
        out.push(node.text);
        return;
      case NodeType.ACTION: {
        const value = this.evalPipeline(node.pipeline, scope);
        if (node.pipeline.declare === null) out.push(formatV(value));
        return;
      }
      case NodeType.IF:
        this.walkBranch(node, scope, out, isTrue(this.evalPipeline(node.pipeline, scope)));
        return;
      case NodeType.WITH: {
        const value = this.evalPipeline(node.pipeline, scope);
        if (isTrue(value)) this.walk(node.body, scope.child(value), out);
        else if (node.elseBody) this.walk(node.elseBody, scope, out);
        return;
      }
      case NodeType.RANGE:
        this.walkRange(node, scope, out);
        return;
      default:
        throw new ExecError(`unknown node ${node.type}`);
    }
  }

  walkBranch(node, scope, out, condition) {
    if (condition) this.walk(node.body, scope, out);
    else if (node.elseBody) this.walk(node.elseBody, scope, out);
  }

  walkRange(node, scope, out) {
    const subject = this.evalPipeline(node.pipeline, scope);
    let iterated = false;
    for (const [key, value] of rangeEntries(subject)) {
      iterated = true;
      const inner = scope.child(value);
      if (node.vars.length === 1) inner.vars.set(node.vars[0], value);
      else if (node.vars.length === 2) {
        inner.vars.set(node.vars[0], key);
        inner.vars.set(node.vars[1], value);
      }
      this.walk(node.body, inner, out);
    }
    if (!iterated && node.elseBody) this.walk(node.elseBody, scope, out);
  }

  evalPipeline(pipeline, scope) {
    let value;
    for (let i = 0; i < pipeline.commands.length; i++) {
      const command = pipeline.commands[i];
      // A pipeline appends the previous stage's result as the final argument.
      const extra = i === 0 ? [] : [value];
      value = this.evalCommand(command, scope, extra);
    }
    if (pipeline.declare !== null) {
      for (const name of pipeline.declare) scope.vars.set(name, value);
    }
    return value;
  }

  evalCommand(command, scope, extra) {
    const [head, ...rest] = command.args;

    if (head.kind === 'func') {
      const fn = this.funcs[head.name];
      if (fn === undefined) throw new ExecError(`function "${head.name}" not defined`);
      const args = [...rest.map((a) => this.evalOperand(a, scope)), ...extra];
      return fn(...args);
    }

    const value = this.evalOperand(head, scope);
    if (rest.length > 0 || extra.length > 0) {
      if (typeof value !== 'function') {
        throw new ExecError(`can't give argument to non-function`);
      }
      return value(...rest.map((a) => this.evalOperand(a, scope)), ...extra);
    }
    return value;
  }

  evalOperand(operand, scope) {
    switch (operand.kind) {
      case 'pipe':
        return this.evalPipeline(operand.pipeline, scope);
      case 'dot':
        return resolvePath(scope.dot, operand.path);
      case 'var': {
        if (!scope.vars.has(operand.name)) {
          throw new ExecError(`undefined variable ${operand.name}`);
        }
        return resolvePath(scope.vars.get(operand.name), operand.path);
      }
      case 'string':
        return operand.value;
      case 'int':
        return operand.value;
      case 'float':
        return operand.value;
      case 'bool':
        return operand.value;
      case 'nil':
        return NO_VALUE;
      case 'func': {
        const fn = this.funcs[operand.name];
        if (fn === undefined) throw new ExecError(`function "${operand.name}" not defined`);
        return fn();
      }
      default:
        throw new ExecError(`unknown operand ${operand.kind}`);
    }
  }
}

/**
 * Field/method traversal.
 *
 * Go treats maps and structs DIFFERENTLY, and the port must too (G-TMPL-2):
 *   map    a missing key yields the element's zero value, and for an
 *          interface-valued map that renders as "<no value>". Not an error.
 *   struct a missing field is an EXECUTION ERROR:
 *            can't evaluate field Missing in type requester.Report
 *
 * Modelling a struct as a plain object makes this security-relevant, not just
 * a fidelity detail: `-o` accepts an arbitrary user template, so a permissive
 * `value[name]` lookup would expose the whole prototype chain — `.constructor`
 * would resolve to a function and then be CALLED by the method branch below.
 * Go rejects that field outright, so lookups are restricted to own properties
 * plus methods declared on the value's own class prototype.
 */
function resolvePath(root, path) {
  let value = root;
  for (const name of path) {
    if (value === NO_VALUE || value === null || value === undefined) return NO_VALUE;
    if (value instanceof Map) {
      value = value.has(name) ? value.get(name) : NO_VALUE;
      continue;
    }
    if (typeof value !== 'object') {
      throw new ExecError(`can't evaluate field ${name} in type ${goTypeName(value)}`);
    }
    value = structField(value, name);
  }
  return value;
}

function structField(obj, name) {
  if (Object.hasOwn(obj, name)) {
    // Returned as-is even when it is a function: Go auto-invokes METHODS, but a
    // struct FIELD of func type is a value you must reach through `call`.
    return obj[name];
  }
  const proto = Object.getPrototypeOf(obj);
  const isOwnClassMethod = proto !== null
    && proto !== Object.prototype
    && Object.hasOwn(proto, name)
    && typeof proto[name] === 'function';
  if (isOwnClassMethod) return proto[name].call(obj);
  throw new ExecError(`can't evaluate field ${name} in type ${goTypeName(obj)}`);
}

function goTypeName(value) {
  if (Array.isArray(value)) return 'slice';
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'object') return value.constructor?.name ?? 'struct';
  return typeof value;
}

/** Ordered [key, value] pairs for `range`; maps use Go's sorted key order. */
function rangeEntries(subject) {
  if (subject === NO_VALUE || subject === null || subject === undefined) return [];
  if (Array.isArray(subject)) return subject.map((v, i) => [BigInt(i), v]);
  if (subject instanceof Map) return templateMapKeys(subject).map((k) => [k, subject.get(k)]);
  if (typeof subject === 'string') return [...subject].map((c, i) => [BigInt(i), c]);
  if (typeof subject === 'bigint') {
    // Generator, not an array: `{{range 100000000}}` would otherwise allocate
    // 100M entries before the first iteration runs.
    return (function* counter() {
      for (let i = 0n; i < subject; i++) yield [i, i];
    }());
  }
  throw new ExecError(`range can't iterate over ${formatV(subject)}`);
}

/** The builtin function set, matching text/template's. */
export const builtinFuncs = {
  len: (v) => {
    if (typeof v === 'string') return BigInt([...v].length);
    if (Array.isArray(v)) return BigInt(v.length);
    if (v instanceof Map) return BigInt(v.size);
    if (v === NO_VALUE || v === null || v === undefined) {
      throw new ExecError('len of untyped nil');
    }
    throw new ExecError(`len of type ${typeof v}`);
  },
  index: (collection, ...indexes) => {
    let value = collection;
    for (const idx of indexes) {
      if (value instanceof Map) {
        value = value.has(idx) ? value.get(idx) : NO_VALUE;
        continue;
      }
      const i = Number(idx);
      if (typeof value === 'string') {
        // Go indexes a string by BYTE and yields a uint8, so `index "abc" 1`
        // is 98, not "b".
        const bytes = new TextEncoder().encode(value);
        if (i < 0 || i >= bytes.length) throw new ExecError(`index out of range: ${i}`);
        value = BigInt(bytes[i]);
        continue;
      }
      if (!Array.isArray(value)) {
        throw new ExecError('index of untyped nil');
      }
      if (i < 0 || i >= value.length) {
        throw new ExecError(`index out of range: ${i}`);
      }
      value = value[i];
    }
    return value;
  },
  print: (...args) => goSprint(args),
  printf: (format, ...args) => sprintf(format, args),
  html: (...args) => escapeHTML(args.map(formatV).join('')),
  js: (...args) => escapeJS(args.map(formatV).join('')),
  urlquery: (...args) => queryEscape(args.map(formatV).join('')),
  call: (fn, ...args) => {
    if (typeof fn !== 'function') throw new ExecError('call of a non-function');
    return fn(...args);
  },
  slice: (item, ...bounds) => {
    if (typeof item !== 'string' && !Array.isArray(item)) {
      throw new ExecError('slice of an un-sliceable type');
    }
    const [lo = 0n, hi = BigInt(item.length)] = bounds;
    return item.slice(Number(lo), Number(hi));
  },
  println: (...args) => `${args.map(formatV).join(' ')}\n`,
  not: (v) => !isTrue(v),
  and: (...args) => args.reduce((acc, v) => (isTrue(acc) ? v : acc)),
  or: (...args) => args.reduce((acc, v) => (isTrue(acc) ? acc : v)),
  eq: (a, ...rest) => rest.some((b) => compareValues(a, b) === 0),
  ne: (a, b) => compareValues(a, b) !== 0,
  lt: (a, b) => compareValues(a, b) < 0,
  le: (a, b) => compareValues(a, b) <= 0,
  gt: (a, b) => compareValues(a, b) > 0,
  ge: (a, b) => compareValues(a, b) >= 0,
};

/** fmt.Sprintf for the verbs a template realistically uses. */
function sprintf(format, args) {
  let i = 0;
  return String(format).replace(/%([-0]*)(\d*)(?:\.(\d+))?([vdsqfxXt%])/gu, (_m, flags, width, prec, verb) => {
    if (verb === '%') return '%';
    const value = args[i++];
    let text;
    switch (verb) {
      case 'd': text = typeof value === 'bigint' ? value.toString() : String(Math.trunc(Number(value))); break;
      case 'f': text = formatF(Number(value), 0, prec === undefined ? 6 : Number(prec)); break;
      case 's': text = formatV(value); break;
      case 'q': text = JSON.stringify(formatV(value)); break;
      case 'x': text = toBase(value, 16, false); break;
      case 'X': text = toBase(value, 16, true); break;
      case 't': text = value ? 'true' : 'false'; break;
      default: text = formatV(value);
    }
    const pad = Number(width || 0);
    if (pad <= text.length) return text;
    if (flags.includes('-')) return text.padEnd(pad, ' ');
    // `%05d` -> "00042"; the zero flag pads AFTER any sign.
    if (flags.includes('0')) {
      const negative = text.startsWith('-');
      const body = negative ? text.slice(1) : text;
      return (negative ? '-' : '') + body.padStart(pad - (negative ? 1 : 0), '0');
    }
    return text.padStart(pad, ' ');
  });
}

function toBase(value, base, upper) {
  const n = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
  const text = n.toString(base);
  return upper ? text.toUpperCase() : text;
}

/**
 * fmt.Sprint: operands are concatenated, and a space is added between two
 * neighbours ONLY when neither of them is a string.
 *   Sprint("a", 1, true) == "a1 true"
 */
function goSprint(args) {
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (i > 0 && typeof args[i - 1] !== 'string' && typeof args[i] !== 'string') out += ' ';
    out += formatV(args[i]);
  }
  return out;
}

/** net/url.QueryEscape — space encodes as '+', unreserved set is Go's. */
function queryEscape(s) {
  let out = '';
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/u.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const HTML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&#34;', "'": '&#39;' };
const escapeHTML = (s) => s.replace(/[<>&"']/gu, (c) => HTML_ESCAPES[c]);
const JS_ESCAPES = { '\\': '\\\\', '"': '\\"', "'": "\\'", '<': '\\u003C', '>': '\\u003E', '&': '\\u0026', '=': '\\u003D' };
const escapeJS = (s) => s.replace(/[\\"'<>&=]/gu, (c) => JS_ESCAPES[c]);

/** template.New(name).Funcs(funcs).Parse(text) */
export function newTemplate(name, text, funcs = {}) {
  const all = { ...builtinFuncs, ...funcs };
  return new Template(name, parse(name, text, new Set(Object.keys(all))), all);
}

export { ExecError, NO_VALUE, GoDuration, formatV };
