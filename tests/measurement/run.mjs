// Salutant's measurement runner. Measures the existing tests only: it spawns
// the suite with the measurement preload active, validates every report,
// merges coverage keyed to path plus content, converts with the converter
// Tetris uses and prints exact covered/total counts per pipeline. Raw reports
// are kept unfiltered under the run directory. Nothing here runs outside
// measurement, and the existing checks behave exactly as today.
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  browserFiles, root, serverFiles, readFile, pageScriptSource, pageScriptLineShift, shiftCoverageLines
} from './filelists.mjs'
import { mergeV8Entries, uncovered } from './v8merge.mjs'
import { toFileCoverage, summarize } from './convert.mjs'
import { MeasurementFailure, checkNavigationCoverage, validateBrowserDir, validateServerDir } from './validate.mjs'
import { checkPages, checkServedScripts } from './checks.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : mkdtempSync(join(tmpdir(), 'salutant-measure-'))
const TIMEOUT_MS = 10 * 60 * 1000
const COMMAND = 'node --test tests/*.test.js'

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim()
}

function toolVersion(name) {
  return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
}

// The pins the report's numbers are only meaningful against, mirroring the
// version assertion the WebKit check runs on its own install. A mismatch
// fails the run instead of producing numbers from a different toolchain.
function checkToolVersions() {
  const manifest = JSON.parse(readFileSync(join(here, 'tools.json'), 'utf8'))
  for (const [name, pinned] of Object.entries(manifest.tools)) {
    let installed
    try {
      installed = toolVersion(name)
    } catch {
      throw new MeasurementFailure(
        `measurement tool ${name} is not installed; provision with the exact command in tools.json`
      )
    }
    if (installed !== pinned) {
      throw new MeasurementFailure(
        `measurement tool ${name} is ${installed}, pinned at ${pinned} in tools.json; reprovision before measuring`
      )
    }
  }
}

function runSuite() {
  const env = {
    ...process.env,
    SALUTANT_MEASURE: '1',
    SALUTANT_MEASURE_DIR: outDir,
    SALUTANT_BROWSER: 'chromium',
    NODE_V8_COVERAGE: join(outDir, 'server'),
    NODE_OPTIONS: [
      `--import ${join(here, 'browser-preload.mjs')}`,
      process.env.NODE_OPTIONS || ''
    ].join(' ')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', 'tests/*.test.js'],
      { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'], shell: false }
    )
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new MeasurementFailure(`suite exceeded ${TIMEOUT_MS / 60000} minutes; run failed, no numbers produced`))
    }, TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(killer)
      if (code === 0) resolve()
      else reject(new MeasurementFailure(`suite exited ${code}; measurement run failed`))
    })
  })
}

// Starts a verification server without any coverage or preload, for the page
// check that must not add coverage to the measurement.
async function withVerificationServer(fn) {
  const { makeWorld } = await import('../helpers.js')
  const w = await makeWorld()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    const out = await w.worker.fetch(new Request(`http://localhost:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined,
    }))
    const cookies = out.headers.getSetCookie()
    for (const [k, v] of out.headers) if (k !== 'set-cookie') res.setHeader(k, v)
    if (cookies.length) res.setHeader('set-cookie', cookies)
    res.statusCode = out.status
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    await fn(`http://localhost:${server.address().port}`)
  } finally {
    server.close()
  }
}

const runStartedAt = Date.now()
mkdirSync(join(outDir, 'server'), { recursive: true })
mkdirSync(join(outDir, 'browser'), { recursive: true })

// The baseline names its production-source commit; the application source is
// verified unchanged from it regardless of which branch the harness sits on,
// and the harness revision is recorded separately.
const PRODUCTION_COMMIT = '3889c1779112d18da4220c7ab8f10ca269e12ad6'
const commit = git('rev-parse', 'HEAD')
const appDiff = git('diff', '--name-only', PRODUCTION_COMMIT, '--', 'src')
if (appDiff) {
  throw new MeasurementFailure(
    `application source differs from the pinned production commit ${PRODUCTION_COMMIT}:\n${appDiff}`
  )
}

console.error(`measuring the full suite at ${commit} into ${outDir}`)
checkToolVersions()
await runSuite()

const serverEntries = validateServerDir(
  join(outDir, 'server'),
  runStartedAt,
  new Set(serverFiles().map((f) => f.url))
)
const browserCaptures = validateBrowserDir(join(outDir, 'browser'))
if (browserFiles().length > 0 && browserCaptures.length === 0) {
  throw new MeasurementFailure(
    'no browser coverage captured; the page script would report 0% without evidence, so the run fails'
  )
}
checkNavigationCoverage(join(outDir, 'browser'))

await withVerificationServer(checkPages)
checkServedScripts(browserCaptures)

// Node pipeline: source comes from disk (V8 reports carry no source), which
// the clean-tree check above ties to the pinned commit.
const serverMerged = mergeV8Entries(
  serverEntries.map((e) => ({ url: e.url, source: readFile(fileURLToPath(e.url)), functions: e.functions }))
)
// Browser scripts key by path, with content identity still enforced across
// every load.
const browserMerged = mergeV8Entries(
  browserCaptures.map((e) => {
    try {
      return { ...e, url: new URL(e.url).pathname }
    } catch {
      return e
    }
  })
)

// The page script converts as served, then every reported line shifts so it
// lands on its exact line in the checked-in src/assets.js.
const pageScriptPath = join(outDir, 'page-script.js')
writeFileSync(pageScriptPath, pageScriptSource())
const lineShift = pageScriptLineShift()

const files = []
for (const f of serverFiles()) {
  const merged = serverMerged.get(f.url)
  if (!merged) continue // never loaded: stays at 0% via the empty-file entry below
  files.push({ path: f.rel, coverage: await toFileCoverage(merged, f.abs) })
}
for (const f of browserFiles()) {
  const merged = browserMerged.get(f.servedPath)
  if (!merged) continue
  files.push({ path: f.rel, coverage: shiftCoverageLines(await toFileCoverage(merged, pageScriptPath), lineShift) })
}
// Files on a list that never loaded count as 0%: give them an empty
// execution so the converter emits fully-uncovered counts.
for (const f of serverFiles()) {
  if (!files.some((x) => x.path === f.rel)) {
    files.push({ path: f.rel, coverage: await toFileCoverage(uncovered(f.url, readFile(f.abs)), f.abs) })
  }
}
for (const f of browserFiles()) {
  if (!files.some((x) => x.path === f.rel)) {
    files.push({ path: f.rel, coverage: shiftCoverageLines(await toFileCoverage(uncovered(f.servedPath, pageScriptSource()), pageScriptPath), lineShift) })
  }
}

const summary = summarize(files)
const report = {
  repo: 'salutant',
  suite: 'full',
  commit: PRODUCTION_COMMIT,
  harnessRevision: git('status', '--porcelain') ? `${commit}+uncommitted` : commit,
  node: process.version,
  browser: 'chromium',
  command: `SALUTANT_BROWSER=chromium ${COMMAND}`,
  toolVersions: {
    playwright: toolVersion('playwright'),
    'v8-to-istanbul': toolVersion('v8-to-istanbul'),
    'istanbul-lib-coverage': toolVersion('istanbul-lib-coverage')
  },
  skippedChecks: {
    lockfileRegistry: 'skipped: zero-dependency repo; no lockfile exists by design and npm ci fails by design',
    thirdPartyPackages: 'skipped: the page loads no third-party scripts'
  },
  fileListScope: {
    server: serverFiles().map((f) => f.rel),
    browser: browserFiles().map((f) => f.rel)
  },
  runStartedAt: new Date(runStartedAt).toISOString(),
  files: summary
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))

for (const rel of [...report.fileListScope.server, ...report.fileListScope.browser]) {
  const s = summary[rel]
  if (!s) {
    console.log(`${rel}: not measured`)
    continue
  }
  console.log(
    `${rel}: lines ${s.lines.covered}/${s.lines.total}, branches ${s.branches.covered}/${s.branches.total}, functions ${s.functions.covered}/${s.functions.total}`
  )
}
console.log(`report: ${join(outDir, 'report.json')}`)
