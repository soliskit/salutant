// Run validation. A report is never assumed from a file's existence: each
// server report must be complete, readable and tied to its own process, and
// stale or cut-off reports are rejected. Browser captures are counted against
// the preload's index so a dropped capture fails the run.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class MeasurementFailure extends Error {}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

// ToString of a JSON-reachable value, exactly: strings identity, other
// primitives String(), arrays join like Array.prototype.toString (null and
// undefined elements empty), plain objects with an own toString key throw
// (their value is never callable from JSON), every other plain object is
// '[object Object]'. field()-read wire data is JSON-only, so this never
// meets symbols, functions or host objects.
/**
 * @param {unknown} value
 * @returns {string}
 */
export function jsonToString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return value
      .map((v) => (v === null || v === undefined ? '' : jsonToString(v)))
      .join(',');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'toString')) {
    throw new TypeError('Cannot convert object to primitive value');
  }
  return '[object Object]';
}

// Reads a property the way plain property access did: null throws the same
// TypeError, any other non-object has no such property.
/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
export function field(value, key) {
  if (value === null || value === undefined) {
    throw new TypeError(
      `Cannot read properties of ${String(value)} (reading '${key}')`
    );
  }
  return isRecord(value) ? value[key] : undefined;
}

/**
 * @param {string} dir
 * @param {number} runStartedAt
 * @param {Set<unknown>} serverUrls
 * @returns {unknown[]}
 */
export function validateServerDir(dir, runStartedAt, serverUrls) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new MeasurementFailure(`no server coverage reports in ${dir}`);
  }
  /** @type {unknown[]} */
  const entries = [];
  let filesWithApp = 0;
  for (const f of files) {
    const path = join(dir, f);
    if (statSync(path).mtimeMs < runStartedAt - 1000) {
      throw new MeasurementFailure(`stale coverage report rejected: ${f}`);
    }
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new MeasurementFailure(
        `cut-off or unreadable coverage report rejected: ${f}`
      );
    }
    const result = field(parsed, 'result');
    if (!Array.isArray(result)) {
      throw new MeasurementFailure(`coverage report has no result array: ${f}`);
    }
    /** @type {unknown[]} */
    const results = result;
    const appEntries = results.filter((r) => serverUrls.has(field(r, 'url')));
    if (appEntries.length > 0) filesWithApp++;
    for (const r of appEntries) entries.push(r);
  }
  if (filesWithApp === 0) {
    throw new MeasurementFailure(
      'no server coverage report is tied to a server process (no report contains the app sources)'
    );
  }
  return entries;
}

/**
 * @param {string} dir
 * @returns {unknown[]}
 */
export function validateBrowserDir(dir) {
  const indexPath = join(dir, 'captures.index');
  /** @type {string[]} */
  let indexed;
  try {
    indexed = readFileSync(indexPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t')[0]);
  } catch {
    indexed = [];
  }
  const present = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const failed = readdirSync(dir).filter((f) => f.endsWith('.failed'));
  for (const f of failed) {
    throw new MeasurementFailure(
      `browser capture failed: ${readFileSync(join(dir, f), 'utf8').trim()}`
    );
  }
  for (const name of indexed) {
    if (!present.includes(name)) {
      throw new MeasurementFailure(
        `a browser capture was dropped: ${name} is indexed but missing`
      );
    }
  }
  for (const name of present) {
    if (!indexed.includes(name)) {
      throw new MeasurementFailure(`unindexed browser capture: ${name}`);
    }
  }
  /** @type {unknown[]} */
  const entries = [];
  for (const name of present) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      throw new MeasurementFailure(
        `cut-off or unreadable browser capture rejected: ${name}`
      );
    }
    const found = field(parsed, 'entries');
    if (!Array.isArray(found)) {
      throw new MeasurementFailure(`browser capture has no entries: ${name}`);
    }
    /** @type {unknown[]} */
    const items = found;
    entries.push(...items);
  }
  return entries;
}

// A run whose coverage data is missing fails the measurement. Every
// navigation must have a capture taken shortly before it - an API-wrapped
// take or a poll - so a navigation can never silently drop a document's
// coverage.
/** @param {string} dir */
export function checkNavigationCoverage(dir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  /** @type {unknown[]} */
  const captures = names.map((f) => {
    /** @type {unknown} */
    const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return parsed;
  });
  /** @type {number[]} */
  const takes = [];
  captures.forEach((c, index) => {
    const at = field(c, 'at');
    if (typeof at !== 'number') {
      throw new MeasurementFailure(
        `capture has no numeric time: ${names[index] ?? ''}`
      );
    }
    takes.push(at);
  });
  takes.sort((a, b) => a - b);
  for (const capture of captures) {
    const navs = field(capture, 'navigations');
    if (!navs) continue;
    const length = Number(
      typeof navs === 'string' ? navs.length : field(navs, 'length')
    );
    for (let i = 1; i < length; i++) {
      const nav =
        typeof navs === 'string' ? navs.charAt(i) : field(navs, String(i));
      const at = field(nav, 'at');
      if (typeof at !== 'number') {
        throw new MeasurementFailure(
          `navigation ${String(i)} has no numeric time`
        );
      }
      const covered = takes.some((t) => t <= at && t >= at - 600);
      if (!covered) {
        throw new MeasurementFailure(
          `coverage data is missing across a navigation to ${String(field(nav, 'url'))}: no capture in the 600ms before it`
        );
      }
    }
  }
}
