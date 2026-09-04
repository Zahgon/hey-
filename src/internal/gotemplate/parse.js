// A parser for the subset of text/template that hey can actually reach.
//
// hey's `-o` flag is documented as "csv", but newTemplate() passes ANY other
// value to template.Must(...Parse(...)). Arbitrary user templates are therefore
// part of the observable contract, not just the two builtin ones. The supported
// grammar is: text, comments, trim markers, pipelines with `|`, parenthesised
// sub-pipelines, literals, field/method chains, variables, and the if/else,
// range/else and with actions.
//
// Anything outside that subset raises a parse error rather than being silently
// mis-rendered — a wrong number is far worse than a refusal.

export const NodeType = {
  TEXT: 'text',
  ACTION: 'action',
  IF: 'if',
  RANGE: 'range',
  WITH: 'with',
  LIST: 'list',
};

class ParseError extends Error {}

/** template.Parse. `name` only appears in error messages, as in Go. */
export function parse(name, input, knownFuncs = null) {
  return new Parser(name, input, knownFuncs).parseTemplate();
}

class Parser {
  constructor(name, input, knownFuncs = null) {
    this.name = name;
    this.input = input;
    this.pos = 0;
    // Go resolves function names at PARSE time, so an unknown function makes
    // template.Must panic before hey sends a single request.
    this.knownFuncs = knownFuncs;
  }

  fail(message) {
    const line = this.input.slice(0, this.pos).split('\n').length;
    throw new ParseError(`template: ${this.name}:${line}: ${message}`);
  }

  parseTemplate() {
    const list = this.parseList(new Set());
    if (this.pos < this.input.length) this.fail('unexpected end of template');
    return list;
  }

  /**
   * Collect nodes until one of `terminators` ({{end}}, {{else}}) is reached.
   * The terminator itself is left unconsumed for the caller to inspect.
   */
  parseList(terminators) {
    const nodes = [];
    for (;;) {
      const open = this.input.indexOf('{{', this.pos);
      if (open === -1) {
        if (this.pos < this.input.length) nodes.push(this.textNode(this.input.slice(this.pos)));
        this.pos = this.input.length;
        if (terminators.size > 0) this.fail('unexpected EOF');
        return { type: NodeType.LIST, nodes };
      }

      let text = this.input.slice(this.pos, open);
      const action = this.readAction(open);

      if (action.trimLeft) text = text.replace(/[\t\n\f\r ]+$/u, '');
      if (text !== '') nodes.push(this.textNode(text));

      if (terminators.has(action.keyword)) {
        this.pendingAction = action;
        return { type: NodeType.LIST, nodes };
      }

      this.pos = action.end;
      const node = this.buildNode(action);
      if (node !== null) nodes.push(node);
      if (this.trimNextLeadingSpace) {
        this.trimNextLeadingSpace = false;
        const rest = this.input.slice(this.pos);
        const trimmed = rest.replace(/^[\t\n\f\r ]+/u, '');
        this.pos += rest.length - trimmed.length;
      }
    }
  }

  textNode(text) {
    return { type: NodeType.TEXT, text };
  }

  /** Locate `{{ ... }}`, honouring `{{-` / `-}}` trim markers and comments. */
  readAction(open) {
    let bodyStart = open + 2;
    let trimLeft = false;
    if (this.input.startsWith('- ', bodyStart) || this.input.startsWith('-\t', bodyStart) || this.input.startsWith('-\n', bodyStart)) {
      trimLeft = true;
      bodyStart += 1;
    }

    if (this.input.startsWith('/*', this.skipSpace(bodyStart))) {
      const commentStart = this.skipSpace(bodyStart);
      const commentEnd = this.input.indexOf('*/', commentStart + 2);
      if (commentEnd === -1) {
        this.pos = open;
        this.fail('unclosed comment');
      }
      const after = this.readClose(commentEnd + 2, open);
      return { ...after, keyword: null, body: '', comment: true, trimLeft };
    }

    const close = this.findClose(bodyStart, open);
    let body = this.input.slice(bodyStart, close.bodyEnd).trim();
    const keyword = /^(if|else|range|with|end)\b/u.exec(body)?.[1] ?? null;
    return { keyword, body, end: close.end, trimRight: close.trimRight, trimLeft, comment: false };
  }

  skipSpace(i) {
    while (i < this.input.length && ' \t\n\r'.includes(this.input[i])) i++;
    return i;
  }

  findClose(bodyStart, open) {
    // Scan for `}}` that is not inside a string, raw string or char literal.
    let i = bodyStart;
    while (i < this.input.length) {
      const ch = this.input[i];
      if (ch === '"' || ch === '`' || ch === "'") {
        i = this.skipQuoted(i, open);
        continue;
      }
      if (ch === '}' && this.input[i + 1] === '}') {
        const trimRight = this.input[i - 1] === '-' && ' \t\n\r'.includes(this.input[i - 2] ?? ' ');
        return { bodyEnd: trimRight ? i - 1 : i, end: i + 2, trimRight };
      }
      i++;
    }
    this.pos = open;
    this.fail('unclosed action');
    return null;
  }

  readClose(from, open) {
    const close = this.findClose(from, open);
    return { end: close.end, trimRight: close.trimRight };
  }

  skipQuoted(i, open) {
    const quote = this.input[i];
    i++;
    while (i < this.input.length) {
      if (quote !== '`' && this.input[i] === '\\') {
        i += 2;
        continue;
      }
      if (this.input[i] === quote) return i + 1;
      i++;
    }
    this.pos = open;
    this.fail('unterminated string');
    return i;
  }

  buildNode(action) {
    if (action.trimRight) this.trimNextLeadingSpace = true;
    if (action.comment) return null;

    switch (action.keyword) {
      case 'if':
      case 'with':
        return this.buildBranch(action, action.keyword === 'if' ? NodeType.IF : NodeType.WITH);
      case 'range':
        return this.buildRange(action);
      case 'else':
      case 'end':
        this.fail(`unexpected {{${action.keyword}}}`);
        return null;
      default: {
        if (action.body === '') this.fail('missing value for command');
        return { type: NodeType.ACTION, pipeline: parsePipeline(action.body, (m) => this.fail(m), this.knownFuncs) };
      }
    }
  }

  buildBranch(action, type) {
    const expr = action.body.slice(action.keyword.length).trim();
    if (expr === '') this.fail(`missing value for ${action.keyword}`);
    const pipeline = parsePipeline(expr, (m) => this.fail(m), this.knownFuncs);
    const { body, elseBody } = this.parseBranchBodies();
    return { type, pipeline, body, elseBody };
  }

  buildRange(action) {
    const expr = action.body.slice('range'.length).trim();
    if (expr === '') this.fail('missing value for range');
    const { vars, pipeline } = parseRangeHeader(expr, (m) => this.fail(m), this.knownFuncs);
    const { body, elseBody } = this.parseBranchBodies();
    return { type: NodeType.RANGE, vars, pipeline, body, elseBody };
  }

  /** Consume `...{{else}}...{{end}}`, supporting `{{else if}}` chains. */
  parseBranchBodies() {
    const body = this.parseList(new Set(['else', 'end']));
    const action = this.pendingAction;
    this.pendingAction = null;
    this.pos = action.end;
    if (action.trimRight) this.trimNextLeadingSpace = true;

    if (action.keyword === 'end') return { body, elseBody: null };

    const rest = action.body.slice('else'.length).trim();
    if (rest.startsWith('if')) {
      const nested = this.buildBranch({ ...action, body: rest, keyword: 'if' }, NodeType.IF);
      return { body, elseBody: { type: NodeType.LIST, nodes: [nested] } };
    }
    const elseBody = this.parseList(new Set(['end']));
    const endAction = this.pendingAction;
    this.pendingAction = null;
    this.pos = endAction.end;
    if (endAction.trimRight) this.trimNextLeadingSpace = true;
    return { body, elseBody };
  }
}

/** `$i, $v := pipeline` | `$v := pipeline` | `pipeline` */
function parseRangeHeader(expr, fail, knownFuncs) {
  const assign = splitTopLevel(expr, ':=');
  if (assign === null) return { vars: [], pipeline: parsePipeline(expr, fail, knownFuncs) };
  const vars = assign.left.split(',').map((v) => v.trim());
  for (const v of vars) {
    if (!/^\$[\p{L}\p{N}_]*$/u.test(v)) fail(`invalid variable name ${v}`);
  }
  if (vars.length > 2) fail('too many declarations in range');
  return { vars, pipeline: parsePipeline(assign.right, fail, knownFuncs) };
}

/** command ('|' command)*, with an optional leading `$x :=` declaration. */
export function parsePipeline(text, fail, knownFuncs = null) {
  let declare = null;
  let rest = text.trim();

  const assign = splitTopLevel(rest, ':=');
  if (assign !== null) {
    const names = assign.left.split(',').map((v) => v.trim());
    for (const n of names) {
      if (!/^\$[\p{L}\p{N}_]*$/u.test(n)) fail(`invalid variable name ${n}`);
    }
    declare = names;
    rest = assign.right;
  }

  const commands = splitPipe(rest).map((c) => parseCommand(c, fail, knownFuncs));
  if (commands.length === 0 || commands.some((c) => c.args.length === 0)) {
    fail('missing value for command');
  }
  return { declare, commands };
}

function parseCommand(text, fail, knownFuncs) {
  return { args: tokenizeOperands(text, fail).map((t) => parseOperand(t, fail, knownFuncs)) };
}

function parseOperand(token, fail, knownFuncs = null) {
  if (token.startsWith('(')) {
    return { kind: 'pipe', pipeline: parsePipeline(token.slice(1, -1), fail, knownFuncs) };
  }
  if (token === '.') return { kind: 'dot', path: [] };
  if (token.startsWith('.')) {
    const path = token.slice(1).split('.');
    if (path.some((p) => p === '')) fail(`bad character in field name ${token}`);
    return { kind: 'dot', path };
  }
  if (token.startsWith('$')) {
    const [name, ...path] = token.split('.');
    if (!/^\$[\p{L}\p{N}_]*$/u.test(name)) fail(`invalid variable name ${name}`);
    return { kind: 'var', name, path };
  }
  if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
  if (token === 'nil') return { kind: 'nil' };
  if (token.startsWith('"') || token.startsWith('`')) {
    return { kind: 'string', value: unquote(token, fail) };
  }
  if (/^[+-]?(\d|\.\d)/u.test(token)) return parseNumber(token, fail);
  if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(token)) {
    if (knownFuncs !== null && !knownFuncs.has(token)) {
      fail(`function ${JSON.stringify(token)} not defined`);
    }
    return { kind: 'func', name: token };
  }
  fail(`unexpected ${JSON.stringify(token)} in operand`);
  return null;
}

function parseNumber(token, fail) {
  // An integer literal stays an integer (BigInt) so it can be compared against
  // Go int/int64 fields without being widened to a float — see G-TMPL-4.
  if (/^[+-]?\d+$/u.test(token)) return { kind: 'int', value: BigInt(token) };
  if (/^[+-]?0[xX][0-9a-fA-F]+$/u.test(token)) return { kind: 'int', value: BigInt(token) };
  const f = Number(token);
  if (Number.isNaN(f) && !/^nan$/iu.test(token)) fail(`illegal number syntax: ${token}`);
  return { kind: 'float', value: f };
}

function unquote(token, fail) {
  if (token.startsWith('`')) return token.slice(1, -1);
  let out = '';
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i++;
    const esc = token[i];
    const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", a: '\x07', b: '\b', f: '\f', v: '\v', '0': '\0' };
    if (esc in simple) {
      out += simple[esc];
    } else if (esc === 'x' || esc === 'u' || esc === 'U') {
      const width = esc === 'x' ? 2 : esc === 'u' ? 4 : 8;
      const hex = token.slice(i + 1, i + 1 + width);
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += width;
    } else {
      fail(`unknown escape \\${esc}`);
    }
  }
  return out;
}

/** Split on `sep` at paren/quote depth 0; returns null when absent. */
function splitTopLevel(text, sep) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipQuotedAt(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      return { left: text.slice(0, i).trim(), right: text.slice(i + sep.length).trim() };
    }
  }
  return null;
}

function splitPipe(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipQuotedAt(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((p) => p !== '');
}

/** Split a command into whitespace-separated operands, keeping (...) intact. */
function tokenizeOperands(text, fail) {
  const tokens = [];
  let i = 0;
  const trimmed = text.trim();
  while (i < trimmed.length) {
    while (i < trimmed.length && ' \t\n\r'.includes(trimmed[i])) i++;
    if (i >= trimmed.length) break;
    const start = i;
    if (trimmed[i] === '(') {
      let depth = 0;
      do {
        if (trimmed[i] === '"' || trimmed[i] === '`' || trimmed[i] === "'") {
          i = skipQuotedAt(trimmed, i) + 1;
          continue;
        }
        if (trimmed[i] === '(') depth++;
        else if (trimmed[i] === ')') depth--;
        i++;
      } while (i < trimmed.length && depth > 0);
      if (depth !== 0) fail('unclosed left paren');
    } else {
      while (i < trimmed.length && !' \t\n\r'.includes(trimmed[i])) {
        if (trimmed[i] === '"' || trimmed[i] === '`' || trimmed[i] === "'") {
          // +1: skipQuotedAt lands ON the closing quote, and `continue` skips
          // the i++ below. Without it `printf "%d" 42` becomes ONE operand.
          i = skipQuotedAt(trimmed, i) + 1;
          continue;
        }
        i++;
      }
    }
    tokens.push(trimmed.slice(start, i));
  }
  return tokens;
}

function skipQuotedAt(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length) {
    if (quote !== '`' && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i;
    i++;
  }
  return i;
}

export { ParseError };
