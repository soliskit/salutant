// Verify one mutation shard's report against the mutants the pinned
// instrumenter generates, and print the shard's evidence table.
//
// Two checks run here:
// 1. Actual vs expected: every mutant the instrumenter generates for this
//    shard's range appears exactly once in the report produced by this job,
//    every reported mutant was generated, and no identity repeats inside the
//    report. A missing report, a missing or unexpected mutant, or a duplicate
//    fails the job.
// 2. Planned coverage (ranged shards only): the multiset union of all planned
//    ranges' generated mutants equals the whole file's generated mutants, so a
//    mutant spanning a range boundary - which Stryker assigns to neither range
//    - fails the job instead of being silently lost. Generation only; no extra
//    mutation runs.
//
// The shard also fails when no mutant has status Killed (a failing test killed
// it); Timeout, Survived, NoCoverage, CompileError, RuntimeError and Ignored do
// not count. Status counts and survivor identities go to the job summary and
// log. Unknown report shapes or statuses fail closed; nothing is normalized
// away.
//
// Usage: INSTRUMENTER_PREFIX=<path with node_modules> node scripts/verify-mutation-report.mjs <file> <report.json> [own-range [all planned ranges...]]
import { createRequire } from 'node:module';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';

const fail = (msg) => {
  console.error(`verify-mutation-report: FAIL: ${msg}`);
  process.exit(1);
};

const [file, reportPath, ownRange, ...plannedRanges] = process.argv.slice(2);
if (!file || !reportPath) {
  fail(
    'usage: verify-mutation-report.mjs <file> <report.json> [own-range [all planned ranges...]]'
  );
}
for (const r of [ownRange, ...plannedRanges].filter(Boolean)) {
  if (!/^\d+-\d+$/.test(r)) fail(`bad range "${r}"`);
}
if (!existsSync(reportPath)) {
  fail(
    `missing report ${reportPath} (a cancelled or interrupted run produces none)`
  );
}

// The report this job produced.
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  fail(`report is not valid JSON: ${error.message}`);
}
if (!report || typeof report !== 'object' || Array.isArray(report)) {
  fail('report schema unsupported: top level is not an object');
}
if (
  !report.files ||
  typeof report.files !== 'object' ||
  Array.isArray(report.files)
) {
  fail('report schema unsupported: missing files object');
}
const entry = report.files[file];
if (!entry || typeof entry !== 'object')
  fail(`report contains no entry for ${file}`);
if (!Array.isArray(entry.mutants)) {
  fail(`report schema unsupported: files["${file}"].mutants is not an array`);
}

const TERMINAL = new Set([
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
  'CompileError',
  'RuntimeError',
  'Ignored'
]);
const isPoint = (p) =>
  p &&
  typeof p === 'object' &&
  typeof p.line === 'number' &&
  typeof p.column === 'number';
const keyOf = (mutatorName, replacement, start, end) =>
  `${mutatorName}|${replacement}|${start.line}:${start.column}-${end.line}:${end.column}`;

const reported = new Map(); // key -> count
const statusOf = new Map(); // key -> status
const statusCounts = new Map();
const survivors = [];
for (const m of entry.mutants) {
  if (
    !m ||
    typeof m !== 'object' ||
    typeof m.mutatorName !== 'string' ||
    typeof m.replacement !== 'string' ||
    !isPoint(m.location?.start) ||
    !isPoint(m.location?.end) ||
    typeof m.status !== 'string'
  ) {
    fail(
      `report schema unsupported: a mutant lacks mutatorName, replacement, location or status`
    );
  }
  if (!TERMINAL.has(m.status)) fail(`unsupported mutant status "${m.status}"`);
  const key = keyOf(
    m.mutatorName,
    m.replacement,
    m.location.start,
    m.location.end
  );
  if (reported.has(key)) fail(`duplicate mutant inside the report: ${key}`);
  reported.set(key, 1);
  statusOf.set(key, m.status);
  statusCounts.set(m.status, (statusCounts.get(m.status) ?? 0) + 1);
  if (m.status === 'Survived') survivors.push(key);
}

// Expected mutants from the pinned instrumenter. Raw instrumenter locations
// are 0-based; the report is 1-based, so expected identities shift +1/+1.
const prefix = process.env.INSTRUMENTER_PREFIX;
if (!prefix) fail('INSTRUMENTER_PREFIX is not set');
const require = createRequire(`${prefix}/node_modules/x.js`);
const { createInstrumenter } = require('@stryker-mutator/instrumenter');
const { createInjector } = require('typed-inject');
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
  fatal() {},
  isTraceEnabled: () => false,
  isDebugEnabled: () => false
};
const instrumenter = createInstrumenter(
  createInjector().provideValue('logger', logger)
);
const content = readFileSync(file, 'utf8');
const lineCount = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
const result = await instrumenter.instrument(
  [{ name: file, mutate: true, content }],
  {
    mutate: [file],
    reporters: [],
    testRunner: 'command',
    plugins: [],
    allowEmpty: true,
    ignorers: [],
    excludedMutations: [],
    mutator: { name: 'DEFAULT', plugins: null, excludedMutations: [] }
  }
);
if (!result || !Array.isArray(result.mutants)) {
  fail('instrumenter returned an unsupported result shape');
}
const oneBased = (p) => ({ line: p.line + 1, column: p.column + 1 });
const all = result.mutants.map((m) => {
  if (
    typeof m.mutatorName !== 'string' ||
    typeof m.replacement !== 'string' ||
    !isPoint(m.location?.start) ||
    !isPoint(m.location?.end)
  ) {
    fail(
      'instrumenter mutant schema unsupported: missing mutatorName, replacement or location'
    );
  }
  const start = oneBased(m.location.start);
  const end = oneBased(m.location.end);
  return { key: keyOf(m.mutatorName, m.replacement, start, end), start, end };
});

// Stryker assigns a mutant to a line range only when its whole node is inside
// (instrumenter shouldMutate), so the range's expected set is a line filter.
const inRange = (m, range) => {
  const [a, b] = range.split('-').map(Number);
  const end = Math.min(b, lineCount);
  return m.start.line >= a && m.end.line <= end;
};

// Planned coverage for ranged shards: union of planned ranges == whole file.
if (plannedRanges.length > 0) {
  const planned = new Map();
  for (const r of plannedRanges) {
    for (const m of all) {
      if (inRange(m, r)) planned.set(m.key, (planned.get(m.key) ?? 0) + 1);
    }
  }
  const missing = all.filter((m) => !planned.has(m.key));
  const doubled = [...planned.entries()].filter(([, n]) => n > 1);
  if (missing.length > 0) {
    fail(
      `planned ranges lose ${missing.length} mutant(s) (spanning a boundary?): ${missing
        .slice(0, 5)
        .map((m) => m.key)
        .join(' ; ')}`
    );
  }
  if (doubled.length > 0) {
    fail(
      `planned ranges generate ${doubled.length} mutant(s) more than once: ${doubled[0][0]}`
    );
  }
}

// Actual vs expected for this shard's own range (or the whole file).
const expected = ownRange ? all.filter((m) => inRange(m, ownRange)) : all;
const expectedKeys = new Map();
for (const m of expected)
  expectedKeys.set(m.key, (expectedKeys.get(m.key) ?? 0) + 1);
const notReported = [...expectedKeys.keys()].filter((k) => !reported.has(k));
const notExpected = [...reported.keys()].filter((k) => !expectedKeys.has(k));
if (notReported.length > 0) {
  fail(
    `report is missing ${notReported.length} expected mutant(s): ${notReported.slice(0, 5).join(' ; ')}`
  );
}
if (notExpected.length > 0) {
  fail(
    `report contains ${notExpected.length} unexpected mutant(s): ${notExpected.slice(0, 5).join(' ; ')}`
  );
}

// Detection floor: at least one mutant killed by a failing test.
const killed = statusCounts.get('Killed') ?? 0;
if (killed === 0) {
  fail(
    'no mutant has status Killed; Timeouts, survivors and errors do not count'
  );
}

// Evidence table: summary (when running in Actions) and log.
const lines = [
  `### ${file}${ownRange ? ' ' + ownRange : ''}`,
  '',
  '| Status | Count |',
  '| --- | ---: |',
  ...[...statusCounts.entries()].sort().map(([s, n]) => `| ${s} | ${n} |`),
  '',
  `${all.length} mutants generated for the whole file; ${expected.length} expected in this shard; ${reported.size} reported; all matched.`
];
if (survivors.length > 0) {
  lines.push('', 'Survivors:');
  for (const s of survivors) lines.push(`- ${s}`);
}
const table = lines.join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n`);
}
console.log('verify-mutation-report: OK');
