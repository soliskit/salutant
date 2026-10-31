// Integrity checks for the measured content: the served page script matches
// the checked-in string it is built from, and no page carries script inside
// its HTML. Salutant is a zero-dependency repo with no lockfile, and the page
// loads no third-party scripts, so the lockfile-registry and third-party
// package checks do not apply; the run report records that reason.
import { MeasurementFailure } from './validate.mjs'
import { browserFiles, pageScriptSource } from './filelists.mjs'
import { PAGE_HTML } from '../../src/assets.js'
import { APP_ORIGIN } from '../helpers.js'

// Every served own-code script in the captures must equal the checked-in
// string it is served from. A mismatch fails the run.
export function checkServedScripts(browserEntries) {
  const own = new Map(browserFiles().map((f) => [f.servedPath, pageScriptSource()]))
  // A capture whose source could not be retrieved carries undefined; that is
  // a retrieval gap, not content. Every retrieved source for a known path
  // must match, and a known path seen only through irretrievable sources
  // fails the run as unverifiable.
  const seenUnverifiable = new Set()
  const seenVerified = new Set()
  for (const entry of browserEntries) {
    let pathname
    try {
      pathname = new URL(entry.url).pathname
    } catch {
      continue
    }
    const expected = own.get(pathname)
    if (expected === undefined) continue
    if (entry.source === undefined) {
      if (!seenVerified.has(pathname)) seenUnverifiable.add(pathname)
      continue
    }
    if (entry.source !== expected) {
      throw new MeasurementFailure(
        `served script differs from its checked-in source: ${pathname}`
      )
    }
    seenVerified.add(pathname)
    seenUnverifiable.delete(pathname)
  }
  for (const pathname of seenUnverifiable) {
    throw new MeasurementFailure(`served script content could not be retrieved for verification: ${pathname}`)
  }
}

// Detects script written inside a page's HTML, including event-handler
// attributes. Fixture-proven; a page that carries one fails the check.
export function findInlineScripts(html, pageName) {
  const problems = []
  const scriptTags = html.match(/<script\b[^>]*>/gi) || []
  for (const tag of scriptTags) {
    if (!/\bsrc\s*=/i.test(tag)) {
      problems.push(`${pageName} has a <script> tag without src`)
    }
  }
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const handlers = stripped.match(/\son[a-z]+\s*=/gi) || []
  for (const h of handlers) {
    problems.push(`${pageName} has an event-handler attribute (${h.trim().split('=')[0]})`)
  }
  return problems
}

// Fetches the sign-in page from a verification server (never a measured one)
// and checks both the inline-script rule and that the served HTML matches the
// checked-in string it is served from.
export async function checkPages(baseUrl) {
  const res = await fetch(
    `${baseUrl}/?app=${encodeURIComponent(APP_ORIGIN)}&state=${'x'.repeat(24)}`
  )
  const html = await res.text()
  if (html !== PAGE_HTML) {
    throw new MeasurementFailure('served page differs from its checked-in string: PAGE_HTML')
  }
  const problems = findInlineScripts(html, 'the sign-in page')
  if (problems.length) {
    throw new MeasurementFailure('inline script check failed: ' + problems.join('; '))
  }
}
