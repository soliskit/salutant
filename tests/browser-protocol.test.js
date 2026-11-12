// R16 browser protocol and the required cross-site login-CSRF mock test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeWorld,
  BrowserSession,
  honestSignIn,
  OWNER,
  ATTACKER,
  SERVICE_ORIGIN,
  APP_ORIGIN,
  readCreated,
  readVerified
} from './helpers.js';

// The TCP port of the page server. A server that is missing or has no TCP
// address fails here as an assertion, where reading the port was a TypeError.
/** @param {import('node:https').Server | undefined} server */
function portOf(server) {
  assert.ok(server, 'the page server was created');
  const address = server.address();
  assert.ok(
    address !== null && typeof address === 'object',
    'the page server has a TCP address'
  );
  return address.port;
}

void test('end to end: address, code, proof, exchange, session - with only first-party cookies in play', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const r = await honestSignIn(w, { browser });
  assert.equal(r.page.status, 200);
  assert.ok(r.exchange !== null, 'honest sign-in returned no exchange');
  assert.equal(r.exchange.status, 200);
  assert.ok(r.complete);
  assert.equal(r.complete.status, 200);
  assert.equal(r.complete.body.sub, OWNER);
  // Every cookie set anywhere in the flow is first-party and host-only.
  const serviceCookies = r.create.headers.getSetCookie();
  for (const line of serviceCookies) {
    assert.ok(
      line.includes('HttpOnly') &&
        line.includes('Secure') &&
        line.includes('SameSite=Strict')
    );
    assert.ok(!line.toLowerCase().includes('domain='), 'host-only');
  }
  assert.ok(
    r.complete.setCookie.includes('SameSite=Lax') &&
      !r.complete.setCookie.toLowerCase().includes('domain=')
  );
});

void test('wrong and sibling origins are not served and cannot start challenges', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  for (const origin of [
    'https://evil.example.test',
    'https://evil.app.example.test',
    'https://app.example.test.evil.test'
  ]) {
    const page = await browser.getPage(origin, 'x'.repeat(24));
    assert.equal(page.status, 400, origin);
    const res = await browser.postChallenge({
      address: OWNER,
      appOrigin: origin,
      stateId: 'x'.repeat(24)
    });
    assert.equal(res.status, 400, origin);
  }
});

void test('the verify response returns only the registered callback, and completion stays on the app origin', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.equal(r.verified.callbackUrl, `${APP_ORIGIN}/auth/callback`);
  assert.ok(r.exchange !== null, 'honest sign-in returned no exchange');
  assert.ok(
    'completeUrl' in r.exchange.body,
    'exchange response has no completion URL'
  );
  assert.equal(
    r.exchange.body.completeUrl,
    `${APP_ORIGIN}/auth/complete`,
    'exactly the registered completion address'
  );
  assert.equal(
    new URL(r.exchange.body.completeUrl).search,
    '',
    'no token in the URL'
  );
});

void test('extra fields naming an outside address do not change the registered callback', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const res = await w.worker.fetch(
    new Request(`${SERVICE_ORIGIN}/v1/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: OWNER,
        appOrigin: APP_ORIGIN,
        stateId: start.stateId,
        callbackUrl: 'https://evil.example.test/steal',
        redirect: 'https://evil.example.test/',
        redirectUri: 'https://evil.example.test/'
      })
    })
  );
  browser._storeCookies(res);
  const created = await readCreated(res);
  await w.service.drain();
  const verify = await browser.verify({
    challengeId: created.challengeId,
    code: w.mailer.lastCode(),
    address: OWNER
  });
  const verified = await readVerified(verify);
  assert.equal(
    verified.callbackUrl,
    `${APP_ORIGIN}/auth/callback`,
    'only the registered callback is returned'
  );
  assert.ok(
    !JSON.stringify(verified).includes('evil.example.test'),
    'no outside address anywhere in the response'
  );
});

void test('altered state is rejected at the exchange', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const state = r.verified.state;
  const alteredState = state.slice(0, -1) + (state.endsWith('Z') ? 'Y' : 'Z');
  const res = await w.app.handleExchange(
    { proof: r.verified.proof, state: alteredState },
    SERVICE_ORIGIN
  );
  assert.notEqual(res.status, 200);
  assert.notEqual(alteredState, state);
});

void test('the exchange answers CORS for the service origin exactly, and nothing else', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const good = await w.app.handleExchange(
    { proof: r.verified.proof, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(good.acao, SERVICE_ORIGIN);
  const r2 = await honestSignIn(w, { redeem: false });
  const bad = await w.app.handleExchange(
    { proof: r2.verified.proof, state: r2.verified.state },
    'https://evil.example.test'
  );
  assert.equal(bad.status, 403);
  assert.equal(bad.acao, null);
});

void test("login CSRF: an attacker-owned state or proof cannot log the victim into the attacker's session", async () => {
  const w = await makeWorld({ allowlist: [OWNER, ATTACKER] });

  // The attacker completes their own sign-in as far as the exchange:
  // their verified state is bound to their own pre-auth cookie.
  const attackerBrowser = new BrowserSession(w);
  const attack = await honestSignIn(w, {
    address: ATTACKER,
    browser: attackerBrowser,
    redeem: false
  });
  const attackExchange = await w.app.handleExchange(
    { proof: attack.verified.proof, state: attack.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(attackExchange.status, 200);

  // The victim begins their own sign-in (own browser, own cookie) but
  // never finishes.
  const victimStart = await w.app.startSignIn(null);

  // Attack: the victim's browser is lured to the completion URL. It
  // carries the victim's cookie, which has no verified state, so no
  // session is created - and certainly not the attacker's.
  const victimComplete = await w.app.handleComplete(
    `pre=${victimStart.cookieValue}`
  );
  assert.equal(victimComplete.status, 401);

  // Even replaying the attacker's proof+state through the victim's
  // completion cannot bind: the state was consumed to the attacker's
  // cookie only, and the proof cannot be redeemed twice.
  const replayExchange = await w.app.handleExchange(
    { proof: attack.verified.proof, state: attack.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(
    'error' in replayExchange.body ? replayExchange.body.error : undefined,
    'replayed'
  );
  const victimComplete2 = await w.app.handleComplete(
    `pre=${victimStart.cookieValue}`
  );
  assert.equal(victimComplete2.status, 401);

  // Sanity: the attacker's own completion works, proving the block is
  // the cookie binding, not a broken flow.
  const ownComplete = await w.app.handleComplete(
    `pre=${attack.start.cookieValue}`
  );
  assert.equal(ownComplete.status, 200);
  assert.equal(ownComplete.body.sub, ATTACKER);
});

void test('a verified state expires: the bounded exchange window is 60 seconds', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const ok = await w.app.handleExchange(
    { proof: r.verified.proof, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(ok.status, 200);
  w.advance(61_000);
  const late = await w.app.handleComplete(`pre=${r.start.cookieValue}`);
  assert.equal(late.status, 401, 'stale verified state is not completable');
});

void test('completion window boundary: 59,999 ms after verification succeeds; 60,000 and 60,001 reject', async () => {
  /** @type {[number, boolean][]} */
  const windows = [
    [59_999, true],
    [60_000, false],
    [60_001, false]
  ];
  for (const [ms, ok] of windows) {
    const w = await makeWorld();
    const r = await honestSignIn(w, { redeem: false });
    const exchange = await w.app.handleExchange(
      { proof: r.verified.proof, state: r.verified.state },
      SERVICE_ORIGIN
    );
    assert.equal(exchange.status, 200, 'setup exchange');
    w.advance(ms);
    const complete = await w.app.handleComplete(`pre=${r.start.cookieValue}`);
    assert.equal(complete.status === 200, ok, `completion at +${ms} ms`);
  }
});

void test('a second proof cannot re-verify an already-verified state', async () => {
  // Two challenges share one app state id and both verify. Redeeming
  // the second proof against the already-verified state is refused as
  // bad_state: the state binding, not proof freshness, refuses it.
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const first = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  const second = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  /** @param {number} i */
  const codeOf = (i) => {
    const found = w.mailer.outbox[i].text.match(/\b(\d{6})\b/);
    assert.ok(found, `message ${i} carries a six-digit code`);
    return found[1];
  };
  const v1 = await readVerified(
    await browser.verify({
      challengeId: first.challengeId,
      code: codeOf(0),
      address: OWNER
    })
  );
  const v2 = await readVerified(
    await browser.verify({
      challengeId: second.challengeId,
      code: codeOf(1),
      address: OWNER
    })
  );
  assert.ok(v1.proof && v2.proof, 'both proofs issued for the one state');
  const ok = await w.app.handleExchange(
    { proof: v1.proof, state: v1.state },
    SERVICE_ORIGIN
  );
  assert.equal(ok.status, 200);
  const again = await w.app.handleExchange(
    { proof: v2.proof, state: v2.state },
    SERVICE_ORIGIN
  );
  assert.equal(again.status, 400);
  assert.equal(
    'error' in again.body ? again.body.error : undefined,
    'bad_state'
  );
});

void test('completion without the pre-auth cookie is refused even with a verified state waiting', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const exchange = await w.app.handleExchange(
    { proof: r.verified.proof, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(exchange.status, 200, 'setup: a verified state exists');
  for (const header of [null, 'sess=abcdef']) {
    const res = await w.app.handleComplete(header);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'no_session');
  }
  // A real pre-auth cookie with no verified sign-in behind it is refused too.
  const unverified = await w.app.startSignIn(null);
  const noVerified = await w.app.handleComplete(
    `pre=${unverified.cookieValue}`
  );
  assert.equal(noVerified.status, 401);
  assert.equal(noVerified.body.error, 'no_verified_signin');
  // The refused attempts did not consume the waiting state.
  const stillThere = await w.app.handleComplete(`pre=${r.start.cookieValue}`);
  assert.equal(stillThere.status, 200);
});

// Real-browser check. Skipped unless SALUTANT_BROWSER names an engine
// ("webkit" or "chromium"); when set, a missing Playwright, a missing
// engine or any failed step fails the test. The page is served over
// https from the same worker the other tests use, with a throwaway
// certificate made in a temporary folder at run time. Only the app's
// callback is stubbed. The service cookie goes through the real browser.
const ENGINE = process.env.SALUTANT_BROWSER;
void test(
  'real browser: sign-in works and the browser keeps and returns the service cookie',
  { skip: ENGINE ? false : 'set SALUTANT_BROWSER=webkit or chromium to run' },
  async () => {
    const playwright = await import('playwright');
    assert.ok(ENGINE, 'SALUTANT_BROWSER names the engine');
    const launcher = playwright[ENGINE];
    assert.ok(launcher, `unknown engine: ${ENGINE}`);
    const dir = mkdtempSync(join(tmpdir(), 'salutant-cert-'));
    const w = await makeWorld();
    /** @type {import('node:https').Server | undefined} */
    let server;
    let browser;
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          join(dir, 'k.pem'),
          '-out',
          join(dir, 'c.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost'
        ],
        { stdio: 'ignore' }
      );
      server = https.createServer(
        {
          key: readFileSync(join(dir, 'k.pem')),
          cert: readFileSync(join(dir, 'c.pem'))
        },
        async (req, res) => {
          // The app's completion page is not the service's, and the app
          // callback is stubbed: answer it here with a plain page so the
          // browser's own handling of a JSON document is not under test.
          if (req.url === '/done') {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end('<!doctype html><title>done</title>');
            return;
          }
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const hasBody = !['GET', 'HEAD'].includes(req.method ?? '');
          const out = await w.worker.fetch(
            new Request(`https://localhost:${portOf(server)}${req.url}`, {
              method: req.method,
              headers: Object.fromEntries(
                Object.entries(req.headers).map(([name, value]) => [
                  name,
                  String(value)
                ])
              ),
              body: hasBody ? Buffer.concat(chunks) : undefined
            })
          );
          const cookies = out.headers.getSetCookie();
          for (const [k, v] of out.headers)
            if (k !== 'set-cookie') res.setHeader(k, v);
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.statusCode = out.status;
          res.end(Buffer.from(await out.arrayBuffer()));
        }
      );
      await new Promise((resolve) =>
        server?.listen(0, '127.0.0.1', () => {
          resolve(undefined);
        })
      );
      const origin = `https://localhost:${portOf(server)}`;
      browser = await launcher.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.route(`${APP_ORIGIN}/**`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': origin },
          body: JSON.stringify({ completeUrl: `${origin}/done` })
        })
      );
      /** @type {string[]} */
      const problems = [];
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
      });
      await page.goto(
        `${origin}/?app=${encodeURIComponent(APP_ORIGIN)}&state=${'x'.repeat(24)}`
      );
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      await page.waitForSelector('#code-form:not([hidden])');
      await w.service.drain();
      const cookies = await context.cookies();
      const sb = cookies.filter((c) => c.name.startsWith('sb_'));
      assert.equal(sb.length, 1, 'the browser kept the service cookie');
      assert.equal(sb[0].secure, true);
      assert.equal(sb[0].httpOnly, true);
      assert.equal(sb[0].sameSite, 'Strict');
      assert.ok(sb[0].path.endsWith('/verify'));
      await page.fill('#code', w.mailer.lastCode());
      const verified = page.waitForResponse((r) => r.url().includes('/verify'));
      await page.click('#code-form button[type="submit"]');
      assert.equal(
        (await verified).status(),
        200,
        'verify only succeeds if the cookie came back'
      );
      await page.waitForURL(`${origin}/done`);
      assert.deepEqual(
        problems.filter((t) => /content security policy/i.test(t)),
        [],
        'no policy violations'
      );
      // Same flow again, but the browser's cookies are dropped before
      // the code is entered: the right code alone is refused.
      await page.goto(
        `${origin}/?app=${encodeURIComponent(APP_ORIGIN)}&state=${'y'.repeat(24)}`
      );
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      await page.waitForSelector('#code-form:not([hidden])');
      await w.service.drain();
      await context.clearCookies();
      await page.fill('#code', w.mailer.lastCode());
      await page.click('#code-form button[type="submit"]');
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return message.textContent?.includes('did not work');
      });
      assert.ok(
        page.url().startsWith(`${origin}/?app=`),
        'still on the sign-in page'
      );
    } finally {
      if (browser) await browser.close();
      if (server) server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

// The page shows its own message when the app refuses the final step. The
// callback is answered with a refusal; the page must say so and stay put.
void test(
  'real browser: a refused final step shows the sign-in failed message and does not navigate',
  { skip: ENGINE ? false : 'set SALUTANT_BROWSER=webkit or chromium to run' },
  async () => {
    const playwright = await import('playwright');
    assert.ok(ENGINE, 'SALUTANT_BROWSER names the engine');
    const launcher = playwright[ENGINE];
    assert.ok(launcher, `unknown engine: ${ENGINE}`);
    const dir = mkdtempSync(join(tmpdir(), 'salutant-cert-'));
    const w = await makeWorld();
    /** @type {import('node:https').Server | undefined} */
    let server;
    let browser;
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          join(dir, 'k.pem'),
          '-out',
          join(dir, 'c.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost'
        ],
        { stdio: 'ignore' }
      );
      server = https.createServer(
        {
          key: readFileSync(join(dir, 'k.pem')),
          cert: readFileSync(join(dir, 'c.pem'))
        },
        async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const hasBody = !['GET', 'HEAD'].includes(req.method ?? '');
          const out = await w.worker.fetch(
            new Request(`https://localhost:${portOf(server)}${req.url}`, {
              method: req.method,
              headers: Object.fromEntries(
                Object.entries(req.headers).map(([name, value]) => [
                  name,
                  String(value)
                ])
              ),
              body: hasBody ? Buffer.concat(chunks) : undefined
            })
          );
          const cookies = out.headers.getSetCookie();
          for (const [k, v] of out.headers)
            if (k !== 'set-cookie') res.setHeader(k, v);
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.statusCode = out.status;
          res.end(Buffer.from(await out.arrayBuffer()));
        }
      );
      await new Promise((resolve) =>
        server?.listen(0, '127.0.0.1', () => {
          resolve(undefined);
        })
      );
      const origin = `https://localhost:${portOf(server)}`;
      browser = await launcher.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const cors = {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'content-type'
      };
      await page.route(`${APP_ORIGIN}/**`, (route) =>
        route.request().method() === 'OPTIONS'
          ? route.fulfill({ status: 204, headers: cors })
          : route.fulfill({
              status: 400,
              contentType: 'application/json',
              headers: cors,
              body: JSON.stringify({ error: 'bad_proof' })
            })
      );
      const start = `${origin}/?app=${encodeURIComponent(APP_ORIGIN)}&state=${'x'.repeat(24)}`;
      await page.goto(start);
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      await page.waitForSelector('#code-form:not([hidden])');
      await w.service.drain();
      await page.fill('#code', w.mailer.lastCode());
      await page.click('#code-form button[type="submit"]');
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return message.textContent === 'Sign-in failed. Please start again.';
      });
      assert.equal(page.url(), start, 'the page did not navigate');
      // The page's two network failure paths: an aborted challenge request
      // and an aborted verify request each show the generic failure message
      // without navigating.
      await page.route('**/v1/challenges', (route) => route.abort());
      await page.goto(start);
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return (
          message.textContent === 'Something went wrong. Please try again.'
        );
      });
      assert.equal(page.url(), start, 'the page did not navigate');
      await page.unroute('**/v1/challenges');
      // A refused creation response (rate limited, no challengeId) keeps the
      // uniform message; the empty challenge then fails at verify like any
      // wrong code, without navigating.
      await page.route('**/v1/challenges', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'rate_limited' })
        })
      );
      await page.goto(start);
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return (
          message.textContent === 'If we can sign you in, a code is on its way.'
        );
      });
      await page.fill('#code', '000000');
      await page.click('#code-form button[type="submit"]');
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return (
          message.textContent ===
          'That code did not work. Check it and try again.'
        );
      });
      assert.equal(page.url(), start, 'the page did not navigate');
      await page.unroute('**/v1/challenges');
      await page.goto(start);
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      await page.waitForSelector('#code-form:not([hidden])');
      await w.service.drain();
      await page.route('**/v1/challenges/*/verify', (route) => route.abort());
      await page.fill('#code', w.mailer.lastCode());
      await page.click('#code-form button[type="submit"]');
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return (
          message.textContent === 'Something went wrong. Please try again.'
        );
      });
      assert.equal(page.url(), start, 'the page did not navigate');
    } finally {
      if (browser) await browser.close();
      if (server) server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

// The page served without its launch parameters (a bookmark, a shared
// link, a stripped redirect) must still fail safe: the empty-parameter
// fallbacks run, the service refuses the parameterless request, and the
// page shows only its generic messages without navigating away.
void test(
  'real browser: the page without its launch parameters fails safe and stays on the page',
  { skip: ENGINE ? false : 'set SALUTANT_BROWSER=webkit or chromium to run' },
  async () => {
    const playwright = await import('playwright');
    assert.ok(ENGINE, 'SALUTANT_BROWSER names the engine');
    const launcher = playwright[ENGINE];
    assert.ok(launcher, `unknown engine: ${ENGINE}`);
    const dir = mkdtempSync(join(tmpdir(), 'salutant-cert-'));
    const w = await makeWorld();
    /** @type {import('node:https').Server | undefined} */
    let server;
    let browser;
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          join(dir, 'k.pem'),
          '-out',
          join(dir, 'c.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost'
        ],
        { stdio: 'ignore' }
      );
      server = https.createServer(
        {
          key: readFileSync(join(dir, 'k.pem')),
          cert: readFileSync(join(dir, 'c.pem'))
        },
        async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const hasBody = !['GET', 'HEAD'].includes(req.method ?? '');
          const out = await w.worker.fetch(
            new Request(`https://localhost:${portOf(server)}${req.url}`, {
              method: req.method,
              headers: Object.fromEntries(
                Object.entries(req.headers).map(([name, value]) => [
                  name,
                  String(value)
                ])
              ),
              body: hasBody ? Buffer.concat(chunks) : undefined
            })
          );
          const cookies = out.headers.getSetCookie();
          for (const [k, v] of out.headers)
            if (k !== 'set-cookie') res.setHeader(k, v);
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.statusCode = out.status;
          res.end(Buffer.from(await out.arrayBuffer()));
        }
      );
      await new Promise((resolve) =>
        server?.listen(0, '127.0.0.1', () => {
          resolve(undefined);
        })
      );
      const origin = `https://localhost:${portOf(server)}`;
      browser = await launcher.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      /** @type {string[]} */
      const problems = [];
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
      });
      // No app and no state parameters: the page is still served (with a
      // 400) and its script runs with both fallbacks.
      const bare = `${origin}/`;
      await page.goto(bare);
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      // The service refuses the parameterless request; the answer has no
      // challenge id, and the page still shows only the generic message.
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return message.textContent?.includes('a code is on its way');
      });
      await page.waitForSelector('#code-form:not([hidden])');
      // Entering any code goes to an empty challenge id and is refused;
      // the page says so generically and does not navigate.
      await page.fill('#code', '000000');
      await page.click('#code-form button[type="submit"]');
      await page.waitForFunction(() => {
        const message = document.getElementById('message');
        if (message === null)
          throw new TypeError('the message element is missing');
        return message.textContent?.includes('did not work');
      });
      assert.equal(page.url(), bare, 'the page never navigated');
      assert.equal(w.mailer.attempts.length, 0, 'no mail was attempted');
      assert.deepEqual(
        problems.filter((t) => /content security policy/i.test(t)),
        [],
        'no policy violations'
      );
    } finally {
      if (browser) await browser.close();
      if (server) server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
