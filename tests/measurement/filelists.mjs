// The settled production file lists for Salutant's measurement. Settling a list
// scopes measurement only; anything the rule leaves out is reported, never
// dropped silently.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PAGE_JS } from '../../src/assets.js'
import { MeasurementFailure } from './validate.mjs'

export const root = fileURLToPath(new URL('../..', import.meta.url))

// Node pipeline: the JavaScript under src/ that the running service loads.
export function serverFiles() {
  return [
    'src/assets.js',
    'src/crypto.js',
    'src/headers.js',
    'src/mail-mock.js',
    'src/service.js',
    'src/storage.js',
    'src/stub-app.js',
    'src/worker.js'
  ].map((rel) => ({
    rel,
    abs: join(root, rel),
    url: 'file://' + join(root, rel)
  }))
}

// Browser pipeline: the sign-in page script is built by the server from the
// PAGE_JS string in src/assets.js and served as /app.js. It is measured as its
// own stable entry mapped back to its checked-in source: never credited to
// Node-side coverage, never double-counted.
export function browserFiles() {
  return [{ rel: 'src/assets.js (page script: /app.js)', servedPath: '/app.js' }]
}

export function readFile(abs) {
  return readFileSync(abs, 'utf8')
}

export function pageScriptSource() {
  return PAGE_JS
}

// The page script converts as served, then every reported line shifts by this
// amount so it lands on its exact line in the checked-in src/assets.js. Only
// valid while the literal uses no escapes or interpolation, which this checks.
export function pageScriptLineShift() {
  const fileSource = readFile(join(root, 'src', 'assets.js'))
  const marker = 'PAGE_JS = `'
  const at = fileSource.indexOf(marker)
  if (at === -1) {
    throw new MeasurementFailure('cannot locate the PAGE_JS literal in src/assets.js')
  }
  if (PAGE_JS.includes('${') || PAGE_JS.includes('\\')) {
    throw new MeasurementFailure(
      'the page script uses interpolation or escapes; its lines no longer map 1:1 to the checked-in source'
    )
  }
  return fileSource.slice(0, at + marker.length).split('\n').length - 1
}

// Shifts every location in an Istanbul file-coverage object by the given
// number of lines, leaving columns and counts untouched.
export function shiftCoverageLines(coverage, shift) {
  const shiftLoc = (loc) => ({
    start: { ...loc.start, line: loc.start.line + shift },
    end: { ...loc.end, line: loc.end.line + shift }
  })
  const out = {
    ...coverage,
    statementMap: {},
    fnMap: {},
    branchMap: {}
  }
  for (const [k, loc] of Object.entries(coverage.statementMap)) {
    out.statementMap[k] = shiftLoc(loc)
  }
  for (const [k, fn] of Object.entries(coverage.fnMap)) {
    out.fnMap[k] = { ...fn, loc: shiftLoc(fn.loc) }
    if (fn.decl) out.fnMap[k].decl = shiftLoc(fn.decl)
  }
  for (const [k, br] of Object.entries(coverage.branchMap)) {
    out.branchMap[k] = {
      ...br,
      loc: shiftLoc(br.loc),
      locations: (br.locations || []).map(shiftLoc)
    }
  }
  return out
}
