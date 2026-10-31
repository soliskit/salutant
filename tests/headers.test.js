// R9 response headers: real GET/POST requests to each route type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { securityHeaders, respond } from '../src/headers.js';
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
  assert.ok(csp.includes("form-action 'none'"), 'no form posting');
  const unknown = await r.browser.getPage('https://app.example.test.evil.test', 'x'.repeat(24));
  assert.equal(unknown.status, 400, 'lookalike origin is not served the page');
});

test('the policy header has exactly the documented directives, semicolon separated, none empty', () => {
  const parse = (h) => h.get('content-security-policy').split(';').map((d) => d.trim());
  const documented = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
    "base-uri 'none'", "frame-ancestors 'none'"];
  assert.ok(!parse(securityHeaders()).includes(''), 'no empty directive');
  assert.deepEqual(parse(securityHeaders()).sort(),
    [...documented, "connect-src 'self'", "form-action 'none'"].sort());
  assert.deepEqual(parse(securityHeaders({ connectOrigin: APP_ORIGIN })).sort(),
    [...documented, `connect-src 'self' ${APP_ORIGIN}`, "form-action 'none'"].sort());
});

test('respond: objects become JSON with a JSON content type, text and empty bodies pass through unchanged', async () => {
  const obj = respond(200, { a: 1 });
  assert.equal(obj.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(await obj.text(), '{"a":1}');
  const text = respond(400, 'plain text');
  assert.equal(text.status, 400);
  assert.equal(await text.text(), 'plain text');
  assert.equal(text.headers.get('content-type')?.startsWith('application/json'), false);
  const empty = respond(404, null);
  assert.equal(empty.status, 404);
  assert.equal(await empty.text(), '');
  assert.equal(empty.headers.get('content-type'), null);
});

test('the page, script and style are real content with the right types', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const page = await browser.getPage(APP_ORIGIN, start.stateId);
  const html = await page.text();
  assert.ok(html.startsWith('<!doctype html>'), 'page is an HTML document');
  for (const wired of ['href="/style.css"', 'src="/app.js"', 'id="address-form"', 'id="code-form"']) {
    assert.ok(html.includes(wired), `page includes ${wired}`);
  }
  const js = await w.worker.fetch(new Request('https://salutant.example.test/app.js'));
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const source = await js.text();
  assert.ok(source.includes('/v1/challenges'), 'script calls the sign-in endpoint');
  assert.doesNotThrow(() => new vm.Script(source), 'script parses');
  const css = await w.worker.fetch(new Request('https://salutant.example.test/style.css'));
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await css.text(), /(^|\})\s*body\s*\{[^}]*font-family\s*:/, 'style sets the body font');
});
test('the page routes answer only their own path and method, with the right content type', async () => {
  const w = await makeWorld();
  const base = 'https://salutant.example.test';
  const get = (path) => w.worker.fetch(new Request(base + path));
  const post = (path) => w.worker.fetch(new Request(base + path, { method: 'POST', body: '{}' }));

  assert.equal((await get('/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await get('/style.css')).headers.get('content-type'), 'text/css; charset=utf-8');

  const start = await w.app.startSignIn(null);
  const page = await new BrowserSession(w).getPage(APP_ORIGIN, start.stateId);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');

  // an unknown path is not the stylesheet, and a POST to a page path is not a page
  const unknown = await get('/nope');
  assert.equal(unknown.status, 404);
  assert.notEqual(unknown.headers.get('content-type'), 'text/css; charset=utf-8');
  for (const path of [`/?app=${encodeURIComponent(APP_ORIGIN)}`, '/app.js', '/style.css']) {
    const res = await post(path);
    assert.notEqual(res.status, 200, `POST ${path} is not served as a page`);
  }

  // The v1 API also answers only its own method: a right path with the
  // wrong method falls through to the same 404 as an unknown route.
  assert.equal((await get('/v1/challenges')).status, 404, 'GET /v1/challenges');
  assert.equal((await get('/v1/challenges/abc/verify')).status, 404, 'GET verify');
  assert.equal((await post('/.well-known/jwks.json')).status, 404, 'POST jwks');
});
