// Converts merged V8 coverage to Istanbul file coverage with the same
// converter Tetris uses, and computes exact covered/total counts.
//
// V8 refines block ranges as code executes, so two loads of identical source
// can carry different range structures. Applying many loads to one converter
// would let those structures multiply locations. Instead each load converts
// on its own and the Istanbul maps merge: locations come from the source's
// own syntax tree, so totals stay stable across runs and reloads, and only
// counts accumulate.
import libCoverage from 'istanbul-lib-coverage';
import V8ToIstanbul from 'v8-to-istanbul';
import { field } from './validate.mjs';

const { createFileCoverage } = libCoverage;

/**
 * @typedef {import('istanbul-lib-coverage').FileCoverageData} FileCoverageData
 * @typedef {{ line: number, column?: number | null }} Position
 * @typedef {{ start: Position, end: Position }} Span
 * @typedef {{ covered: number, total: number }} Count
 * @typedef {{
 *   lines: Count,
 *   branches: Count,
 *   functions: Count & { measurable?: boolean }
 * }} FileSummary
 */

// merged: { url, source, coverageList: [functions, ...] } ; path for the report
// V8 lists a function only once it is compiled, so a load where a function
// never compiled has no entry for it, and converting that load credits the
// function's body through the enclosing range. Absent means never compiled,
// which means never run: completing each load with zero-count spans for the
// functions other loads of the same source observed removes only credit no
// execution could have produced. This happens at the V8 level because the
// converter's own function map drops anonymous functions entirely.
// Reads of unknown wire data, kept identical to the property reads the
// original inline code made: a falsy list counts as empty, and a truthy
// non-array fails with the original TypeError text (verified against the
// original expressions on pinned Node).
/**
 * The union pass iterated `(functions || [])` directly: arrays and strings
 * iterate (strings yield their characters, which carry no ranges), anything
 * else fails as not iterable.
 * @param {unknown} list
 */
function unionEntriesOf(list) {
  if (!list) return [];
  if (typeof list === 'string' || Array.isArray(list)) return list;
  throw new TypeError('(functions || []) is not iterable');
}

/**
 * The completion pass read its list through `.filter`, so a truthy non-array
 * fails with the original property-access TypeError.
 * @param {unknown} list
 */
function filterEntriesOf(list) {
  if (!list) return [];
  if (Array.isArray(list)) return list;
  throw new TypeError('(functions || []).filter is not a function');
}

/**
 * @param {unknown} fn
 * @returns {{ start: number, end: number } | undefined}
 */
function spanOf(fn) {
  const ranges = field(fn, 'ranges');
  if (!ranges || field(ranges, 'length') === 0) return undefined;
  if (!Array.isArray(ranges)) {
    // The original evaluated fn.ranges.map here and failed with this
    // TypeError (verified against the original expression on pinned Node).
    throw new TypeError('fn.ranges.map is not a function');
  }
  return {
    start: Math.min(...ranges.map((r) => Number(field(r, 'startOffset')))),
    end: Math.max(...ranges.map((r) => Number(field(r, 'endOffset'))))
  };
}

/**
 * @param {unknown[]} coverageList
 * @returns {unknown[]}
 */
export function completeFunctionLists(coverageList) {
  /** @type {Map<string, { name: unknown, start: number, end: number }>} */
  const union = new Map();
  for (const list of coverageList) {
    for (const fn of unionEntriesOf(list)) {
      const span = spanOf(fn);
      if (!span) continue;
      const name = field(fn, 'functionName');
      const key = `${String(name)}@${String(span.start)}-${String(span.end)}`;
      if (!union.has(key)) union.set(key, { name, ...span });
    }
  }
  return coverageList.map((list) => {
    const functions = filterEntriesOf(list);
    const present = new Set();
    /** @type {{ start: number, end: number }[]} */
    const presentSpans = [];
    for (const fn of functions) {
      const span = spanOf(fn);
      if (!span) continue;
      present.add(
        `${String(field(fn, 'functionName'))}@${String(span.start)}-${String(span.end)}`
      );
      presentSpans.push(span);
    }
    // Partial writes can list a function that ran while omitting its
    // ancestors; a zero span containing a present function's span would
    // erase real credit, so it is never inserted. The ancestor's own
    // statements are carried by complete takes.
    /** @type {unknown[]} */
    const added = [];
    for (const [key, fn] of union) {
      if (present.has(key)) continue;
      if (
        presentSpans.some(
          (p) =>
            fn.start <= p.start &&
            p.end <= fn.end &&
            (fn.start < p.start || p.end < fn.end)
        )
      )
        continue;
      added.push({
        functionName: fn.name,
        isBlockCoverage: true,
        ranges: [{ startOffset: fn.start, endOffset: fn.end, count: 0 }]
      });
    }
    return added.length ? [...functions, ...added] : list;
  });
}

// What v8-to-istanbul reads from one load's function list. Each field the
// library uses is checked here and rebuilt, so the typed call below is true
// for every list it receives. Shapes the library cannot use at all (a list
// that is not an array, a block that is not an object or has no ranges list,
// a null range) throw TypeError here, as they did inside the library. A
// falsy functionName and any isBlockCoverage are read by truthiness in the
// library, so they are normalized without changing what it does (the one
// strict comparison, functionName === '(empty-report)', is unaffected because
// a falsy name becomes ''). Three classes of shape are rejected here and were
// accepted before: a range that is not an object (a number, string or
// boolean), a range whose startOffset, endOffset or count is missing or not a
// number (offsets are only used in arithmetic, so a numeric string was
// coerced and worked, while count reaches the report raw, so a string count
// was written into the output), and a truthy functionName that is not a
// string (it was written into the report's function map as given).
/**
 * applyCoverage receives each take's blocks exactly as the original inline
 * call delivered them: array takes pass through unchecked with no coercion,
 * as before. completeFunctionLists above rejects every truthy non-array take
 * with the original TypeErrors, so the only values that can arrive here
 * non-array are falsy ones (a take carrying no functions entry at all -
 * malformed fixture data only), which the original inline call forwarded to
 * applyCoverage(blocks) whose first use is blocks.forEach. The throws below
 * reproduce those exact library TypeErrors (execution-verified on pinned
 * Node 26.13.0 with v8-to-istanbul 9.3.0).
 * @param {unknown} functions
 * @returns {import('inspector').Profiler.FunctionCoverage[]}
 */
function takeBlocks(functions) {
  if (!Array.isArray(functions)) {
    if (functions === undefined || functions === null) {
      throw new TypeError(
        `Cannot read properties of ${functions} (reading 'forEach')`
      );
    }
    throw new TypeError('blocks.forEach is not a function');
  }
  return functions;
}

/**
 * @param {{
 *   url?: unknown,
 *   source?: unknown,
 *   coverageList?: unknown[],
 *   functions?: unknown
 * }} merged
 * @param {string} path
 * @returns {Promise<FileCoverageData>}
 */
export async function toFileCoverage(merged, path) {
  /** @type {FileCoverageData[]} */
  const coverages = [];
  for (const functions of completeFunctionLists(
    merged.coverageList || [merged.functions]
  )) {
    const converter = V8ToIstanbul(path, 0);
    await converter.load();
    converter.applyCoverage(takeBlocks(functions));
    coverages.push(converter.toIstanbul()[path]);
  }
  return zeroUncalledFunctionBodies(coverages.reduce(maxMergeFileCoverages));
}

// A function no load invoked can never have executed a statement or branch
// in its body. V8 compiles lazily: loads where such a function had no entry
// at all credit its body through the enclosing range, and the per-location
// max-merge keeps that false credit. Zeroing body locations after the union
// removes only credit no execution could have produced, so it cannot turn
// real coverage into a false negative. Locations compare by line and
// column; a statement sharing a line with code outside the body keeps its
// own count because containment uses both.
/**
 * @param {Span} outer
 * @param {Span} loc
 * @returns {boolean}
 */
function contains(outer, loc) {
  const startCol = loc.start.column ?? 0;
  const outerStartCol = outer.start.column ?? 0;
  const startsInside =
    loc.start.line > outer.start.line ||
    (loc.start.line === outer.start.line && startCol >= outerStartCol);
  const endCol = loc.end.column ?? Number.MAX_SAFE_INTEGER;
  const outerEndCol = outer.end.column ?? Number.MAX_SAFE_INTEGER;
  const endsInside =
    loc.end.line < outer.end.line ||
    (loc.end.line === outer.end.line && endCol <= outerEndCol);
  return startsInside && endsInside;
}

/**
 * @param {FileCoverageData} coverage
 * @returns {FileCoverageData}
 */
export function zeroUncalledFunctionBodies(coverage) {
  const out = { ...coverage, s: { ...coverage.s }, b: { ...coverage.b } };
  for (const [k, fn] of Object.entries(coverage.fnMap)) {
    if (coverage.f[k] > 0) continue;
    for (const [sk, stmt] of Object.entries(coverage.statementMap)) {
      if (contains(fn.loc, stmt)) out.s[sk] = 0;
    }
    for (const [bk, br] of Object.entries(coverage.branchMap)) {
      if (contains(fn.loc, br.loc)) out.b[bk] = out.b[bk].map(() => 0);
    }
  }
  return out;
}

/**
 * @param {Span} a
 * @param {Span} b
 * @returns {boolean}
 */
function sameLocation(a, b) {
  return (
    a.start.line === b.start.line &&
    a.start.column === b.start.column &&
    a.end.line === b.end.line &&
    a.end.column === b.end.column
  );
}

// Statement maps are identical for identical source, so statement counts
// merge by key. Function and branch maps include only what a load's ranges
// reached, so their numeric keys are load-local: the same key can name a
// different function in another load. Those merge by identity - a location
// already present takes the max count; a new location is appended under a
// fresh key. A path is covered when any load executed it, and cumulative
// writes (a mid-run snapshot plus the exit write) never double-count.
/**
 * @param {FileCoverageData} a
 * @param {FileCoverageData} b
 * @returns {FileCoverageData}
 */
export function maxMergeFileCoverages(a, b) {
  const out = {
    ...a,
    s: { ...a.s },
    f: { ...a.f },
    b: { ...a.b },
    fnMap: { ...a.fnMap },
    branchMap: { ...a.branchMap }
  };
  for (const [k, v] of Object.entries(b.s))
    out.s[k] = Math.max(out.s[k] ?? 0, v);

  let nextFn =
    Object.keys(out.fnMap).reduce((m, k) => Math.max(m, Number(k)), -1) + 1;
  for (const [bk, bfn] of Object.entries(b.fnMap)) {
    const match = Object.entries(out.fnMap).find(
      ([, f]) => f.name === bfn.name && sameLocation(f.decl, bfn.decl)
    );
    if (match) {
      out.f[match[0]] = Math.max(out.f[match[0]] ?? 0, b.f[bk] ?? 0);
    } else {
      out.fnMap[String(nextFn)] = bfn;
      out.f[String(nextFn)] = b.f[bk] ?? 0;
      nextFn++;
    }
  }

  let nextBr =
    Object.keys(out.branchMap).reduce((m, k) => Math.max(m, Number(k)), -1) + 1;
  for (const [bk, bbr] of Object.entries(b.branchMap)) {
    const match = Object.entries(out.branchMap).find(
      ([, br]) => br.type === bbr.type && sameLocation(br.loc, bbr.loc)
    );
    if (match) {
      // Sub-location arrays also differ structurally across loads, so merge
      // path counts by sub-location identity, never element-wise.
      const mk = match[0];
      const locs = (out.branchMap[mk].locations || []).slice();
      const counts = (out.b[mk] || []).slice();
      const incLocs = bbr.locations || [];
      const incCounts = b.b[bk] || [];
      incLocs.forEach((loc, i) => {
        const j = locs.findIndex((x) => sameLocation(x, loc));
        if (j === -1) {
          locs.push(loc);
          counts.push(incCounts[i] ?? 0);
        } else {
          counts[j] = Math.max(counts[j] ?? 0, incCounts[i] ?? 0);
        }
      });
      out.branchMap[mk] = { ...out.branchMap[mk], locations: locs };
      out.b[mk] = counts;
    } else {
      out.branchMap[String(nextBr)] = bbr;
      out.b[String(nextBr)] = (b.b[bk] || []).slice();
      nextBr++;
    }
  }
  return out;
}

// per-file exact counts
/**
 * @param {{ path: string, coverage: FileCoverageData }[]} files
 * @returns {Partial<Record<string, FileSummary>>}
 */
export function summarize(files) {
  /** @type {Partial<Record<string, FileSummary>>} */
  const perFile = {};
  for (const f of files) {
    const summary = createFileCoverage(f.coverage).toSummary();
    // A file whose functions are all anonymous reaches the converter with an
    // empty function map: 0/0 must read as not measurable, never as 100%.
    const functionsMeasurable = summary.functions.total > 0;
    perFile[f.path] = {
      lines: { covered: summary.lines.covered, total: summary.lines.total },
      branches: {
        covered: summary.branches.covered,
        total: summary.branches.total
      },
      functions: functionsMeasurable
        ? { covered: summary.functions.covered, total: summary.functions.total }
        : { covered: 0, total: 0, measurable: false }
    };
  }
  return perFile;
}
