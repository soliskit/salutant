// Type-checks every source, script and test file with the TypeScript
// compiler (tsconfig.all.json) and allows only the expected diagnostics
// listed below.
//
// Each expected entry keys one diagnostic site by the file, the title of
// the enclosing test(), the callee text, the rejected argument's index and
// source text, the diagnostic code and the full flattened message text.
// Cardinality is exact: `count` is the number of diagnostics the key must
// match, so a
// fixed call site that stops erroring (missing) and a new error at a known
// site (extra) both fail. The list is updated only by hand with the change
// explained in its commit; the script never rewrites it.
//
// The five current entries are the retained invalid-input tests whose call
// sites are intentionally ill-typed - exercising the runtime validation is
// the point of each test.

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {object} Expected
 * @property {string} file
 * @property {string} test
 * @property {string} callee
 * @property {number} arg
 * @property {string} argText
 * @property {number} code
 * @property {string} message
 * @property {number} count
 */

/** @type {Expected[]} */
const EXPECTED = [
  {
    file: 'tests/do-stored-boundaries.test.js',
    test: 'DO a missing cache entry from the public cache seam still fails at member use',
    callee: 's.tx.set',
    arg: 1,
    argText: 'undefined',
    code: 2345,
    message:
      "Argument of type 'undefined' is not assignable to parameter of type '{ value: unknown; dirty: boolean; }'.",
    count: 1
  },
  {
    file: 'tests/failure-modes.test.js',
    test: 'mock mail adapter: request id required, accepted sends, reconcile results, last code',
    callee: 'mail.send',
    arg: 0,
    argText: "{ to: OWNER, subject: 's', text: 't' }",
    code: 2345,
    message:
      "Argument of type '{ to: string; subject: string; text: string; }' is not assignable to parameter of type '{ requestId: string; to: string; subject: string; text: string; }'.   Property 'requestId' is missing in type '{ to: string; subject: string; text: string; }' but required in type '{ requestId: string; to: string; subject: string; text: string; }'.",
    count: 1
  },
  {
    file: 'tests/mail-resend.test.js',
    test: 'constructor requires apiKey and from',
    callee: 'ResendMailAdapter',
    arg: 0,
    argText: '{ from: FROM }',
    code: 2345,
    message:
      "Argument of type '{ from: string; }' is not assignable to parameter of type '{ apiKey: string; from: string; fetchImpl?: { (input: URL | RequestInfo, init?: RequestInit | undefined): Promise<Response>; (input: string | ... 1 more ... | Request, init?: RequestInit | undefined): Promise<...>; } | undefined; timeoutMs?: number | undefined; }'.   Property 'apiKey' is missing in type '{ from: string; }' but required in type '{ apiKey: string; from: string; fetchImpl?: { (input: URL | RequestInfo, init?: RequestInit | undefined): Promise<Response>; (input: string | ... 1 more ... | Request, init?: RequestInit | undefined): Promise<...>; } | undefined; timeoutMs?: number | undefined; }'.",
    count: 1
  },
  {
    file: 'tests/mail-resend.test.js',
    test: 'constructor requires apiKey and from',
    callee: 'ResendMailAdapter',
    arg: 0,
    argText: '{ apiKey: KEY }',
    code: 2345,
    message:
      "Argument of type '{ apiKey: string; }' is not assignable to parameter of type '{ apiKey: string; from: string; fetchImpl?: { (input: URL | RequestInfo, init?: RequestInit | undefined): Promise<Response>; (input: string | ... 1 more ... | Request, init?: RequestInit | undefined): Promise<...>; } | undefined; timeoutMs?: number | undefined; }'.   Property 'from' is missing in type '{ apiKey: string; }' but required in type '{ apiKey: string; from: string; fetchImpl?: { (input: URL | RequestInfo, init?: RequestInit | undefined): Promise<Response>; (input: string | ... 1 more ... | Request, init?: RequestInit | undefined): Promise<...>; } | undefined; timeoutMs?: number | undefined; }'.",
    count: 1
  },
  {
    file: 'tests/mail-resend.test.js',
    test: 'send requires requestId',
    callee: 'a.send',
    arg: 0,
    argText: '{ to: MSG.to, subject: MSG.subject, text: MSG.text }',
    code: 2345,
    message:
      "Argument of type '{ to: string; subject: string; text: string; }' is not assignable to parameter of type '{ requestId: string; to: string; subject: string; text: string; }'.   Property 'requestId' is missing in type '{ to: string; subject: string; text: string; }' but required in type '{ requestId: string; to: string; subject: string; text: string; }'.",
    count: 1
  }
];

/**
 * @param {Expected} e
 * @returns {string}
 */
function expectedKey(e) {
  return `${e.file}::${e.test}::${e.callee}::arg${String(e.arg)} ${e.argText}::TS${String(e.code)}: ${e.message}`;
}

/**
 * The smallest expression spanning exactly [start, end), or undefined.
 * @param {ts.SourceFile} sf
 * @param {number} start
 * @param {number} end
 * @returns {ts.Expression | undefined}
 */
function findNode(sf, start, end) {
  /** @type {ts.Expression | undefined} */
  let found;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      node.getStart() === start &&
      node.getEnd() === end &&
      ts.isExpression(node)
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Child-to-parent links for one source file, cached per file. ts.Node.parent
 * is typed as always defined, so a direct `.parent` loop cannot express the
 * walk-off-the-top end; the map lookup can.
 * @param {ts.SourceFile} sf
 * @returns {Map<ts.Node, ts.Node>}
 */
function parentsOf(sf) {
  /** @type {Map<ts.Node, ts.Node>} */
  const parents = new Map();
  /** @param {ts.Node} node */
  const record = (node) => {
    ts.forEachChild(node, (child) => {
      parents.set(child, node);
      record(child);
    });
  };
  record(sf);
  return parents;
}

/**
 * The innermost call or new expression taking node as a direct argument,
 * and the argument's index.
 * @param {ts.Node} node
 * @param {Map<ts.Node, ts.Node>} parents
 * @returns {{ call: ts.CallExpression | ts.NewExpression, index: number } | undefined}
 */
function enclosingCall(node, parents) {
  /** @type {ts.Node} */
  let child = node;
  for (let cur = parents.get(node); cur; cur = parents.get(cur)) {
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur)) {
      // A new expression may carry no argument list at all.
      const index = cur.arguments
        ? cur.arguments.findIndex((a) => a === child)
        : -1;
      if (index >= 0) return { call: cur, index };
    }
    child = cur;
  }
  return undefined;
}

/**
 * The title of the nearest enclosing test('title', ...) call, or undefined.
 * @param {ts.Node} node
 * @param {Map<ts.Node, ts.Node>} parents
 * @returns {string | undefined}
 */
function enclosingTest(node, parents) {
  for (let cur = parents.get(node); cur; cur = parents.get(cur)) {
    if (
      ts.isCallExpression(cur) &&
      cur.expression.getText() === 'test' &&
      cur.arguments.length > 0 &&
      ts.isStringLiteral(cur.arguments[0])
    ) {
      return cur.arguments[0].text;
    }
  }
  return undefined;
}

/**
 * The expected-style key for one diagnostic, or undefined when the
 * diagnostic has no file or no anchored call site.
 * @param {ts.Diagnostic} d
 * @returns {string | undefined}
 */
function diagnosticKey(d) {
  if (!d.file || d.start === undefined || d.length === undefined) {
    return undefined;
  }
  const node = findNode(d.file, d.start, d.start + d.length);
  if (!node) return undefined;
  const parents = parentsOf(d.file);
  const call = enclosingCall(node, parents);
  if (!call) return undefined;
  const test = enclosingTest(call.call, parents);
  if (test === undefined) return undefined;
  const file = relative(root, d.file.fileName).replace(/\\/g, '/');
  const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  return `${file}::${test}::${call.call.expression.getText()}::arg${String(call.index)} ${node.getText()}::TS${String(d.code)}: ${message}`;
}

/**
 * @param {ts.Diagnostic} d
 * @returns {string}
 */
function describe(d) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  if (!d.file || d.start === undefined) return `global: ${message}`;
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  const file = relative(root, d.file.fileName).replace(/\\/g, '/');
  return `${file}(${String(line + 1)},${String(character + 1)}): error TS${String(d.code)}: ${message}`;
}

const configPath = ts.findConfigFile(
  root,
  (f) => ts.sys.fileExists(f),
  'tsconfig.all.json'
);
if (!configPath) {
  console.error('tsconfig.all.json not found');
  process.exit(1);
}
const read = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
if (read.error) {
  console.error(describe(read.error));
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];

/** @type {Map<string, number>} */
const observed = new Map();
/** @type {ts.Diagnostic[]} */
const unexpected = [];
for (const d of diagnostics) {
  const key = diagnosticKey(d);
  const entry = EXPECTED.find((e) => expectedKey(e) === key);
  if (key !== undefined && entry) {
    observed.set(key, (observed.get(key) ?? 0) + 1);
  } else {
    unexpected.push(d);
  }
}

let failed = false;
for (const e of EXPECTED) {
  const count = observed.get(expectedKey(e)) ?? 0;
  if (count !== e.count) {
    console.error(
      `expected diagnostic ${expectedKey(e)} matched ${String(count)} time(s), expected ${String(e.count)}`
    );
    failed = true;
  }
}
for (const d of unexpected) {
  console.error(`unexpected diagnostic: ${describe(d)}`);
  failed = true;
}
if (failed) process.exit(1);
console.error(
  `type-check clean apart from the ${String(EXPECTED.reduce((n, e) => n + e.count, 0))} expected diagnostic(s)`
);
