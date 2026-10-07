// R9 response headers: real GET/POST requests to each route type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, honestSignIn, OWNER, APP_ORIGIN } from './helpers.js';

const REQUIRED = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

function assertHeaderSet(res, label) {
  for (const [name, value] of Object.entries(REQUIRED)) {
    assert.equal(res.headers.get(name), value, `${label}: ${name}`);
  }
  const csp = res.headers.get('content-security-policy') ?? '';
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'",
    "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `${label}: CSP has ${directive}`);
  }
}

test('every route type carries the full header set', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const routes = {
    'GET / (known app)': await browser.getPage(APP_ORIGIN, start.stateId),
    'GET / (unknown app)': await browser.getPage('https://evil.example.test', start.stateId),
    'GET /app.js': await w.worker.fetch(new Request('https://salutant.example.test/app.js')),
    'GET /style.css': await w.worker.fetch(new Request('https://salutant.example.test/style.css')),
    'POST /v1/challenges': await browser.postChallenge({ address: OWNER, stateId: start.stateId }),
    'POST verify (error)': await browser.verify({ challengeId: 'nope', code: '000000', address: OWNER }),
    'GET jwks': await w.service.fetch(new Request('https://salutant.example.test/.well-known/jwks.json')),
    '404': await w.worker.fetch(new Request('https://salutant.example.test/nope')),
  };
  for (const [label, res] of Object.entries(routes)) assertHeaderSet(res, label);
  // no-store on sign-in and proof responses
  assert.equal(routes['POST /v1/challenges'].headers.get('cache-control'), 'no-store');
  assert.equal(routes['POST verify (error)'].headers.get('cache-control'), 'no-store');
  // the key endpoint may be cached for 5 minutes, not longer
  assert.equal(routes['GET jwks'].headers.get('cache-control'), 'public, max-age=300');
});

test('a proof response carries no-store and the page limits connect-src to the one exact origin', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.equal(r.verify.headers.get('cache-control'), 'no-store');
  const csp = r.page.headers.get('content-security-policy');
  assert.ok(csp.includes(`connect-src 'self' ${APP_ORIGIN}`), 'connect-src is exact');
  assert.ok(csp.includes("form-action 'none'"), 'no form posting (option 2)');
  const unknown = await r.browser.getPage('https://app.example.test.evil.test', 'x'.repeat(24));
  assert.equal(unknown.status, 400, 'lookalike origin is not served the page');
});
