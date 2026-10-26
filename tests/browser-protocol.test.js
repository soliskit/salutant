// R16 browser protocol and the required cross-site login-CSRF mock test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, BrowserSession, honestSignIn, OWNER, ATTACKER, SERVICE_ORIGIN, APP_ORIGIN } from './helpers.js';

test('end to end: address, code, proof, exchange, session - with only first-party cookies in play', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const r = await honestSignIn(w, { browser });
  assert.equal(r.page.status, 200);
  assert.equal(r.exchange.status, 200);
  assert.equal(r.complete.status, 200);
  assert.equal(r.complete.body.sub, OWNER);
  // Every cookie set anywhere in the flow is first-party and host-only.
  const serviceCookies = r.create.headers.getSetCookie();
  for (const line of serviceCookies) {
    assert.ok(line.includes('HttpOnly') && line.includes('Secure') && line.includes('SameSite=Strict'));
    assert.ok(!line.toLowerCase().includes('domain='), 'host-only');
  }
  assert.ok(r.complete.setCookie.includes('SameSite=Lax') && !r.complete.setCookie.toLowerCase().includes('domain='));
});

test('wrong and sibling origins are not served and cannot start challenges', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  for (const origin of ['https://evil.example.test', 'https://evil.app.example.test', 'https://app.example.test.evil.test']) {
    const page = await browser.getPage(origin, 'x'.repeat(24));
    assert.equal(page.status, 400, origin);
    const res = await browser.postChallenge({ address: OWNER, appOrigin: origin, stateId: 'x'.repeat(24) });
    assert.equal(res.status, 400, origin);
  }
});

test('the verify response returns only the registered callback, and completion stays on the app origin', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.equal(r.verified.callbackUrl, `${APP_ORIGIN}/auth/callback`);
  assert.ok(r.exchange.body.completeUrl.startsWith(APP_ORIGIN));
  assert.equal(new URL(r.exchange.body.completeUrl).search, '', 'no token in the URL');
});

test('altered state is rejected at the exchange', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const state = r.verified.state;
  const alteredState = state.slice(0, -1) + (state.endsWith('Z') ? 'Y' : 'Z');
  const res = await w.app.handleExchange({ proof: r.verified.proof, state: alteredState }, SERVICE_ORIGIN);
  assert.notEqual(res.status, 200);
  assert.notEqual(alteredState, state);
});

test('the exchange answers CORS for the service origin exactly, and nothing else', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const good = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
  assert.equal(good.acao, SERVICE_ORIGIN);
  const r2 = await honestSignIn(w, { redeem: false });
  const bad = await w.app.handleExchange({ proof: r2.verified.proof, state: r2.verified.state }, 'https://evil.example.test');
  assert.equal(bad.status, 403);
  assert.equal(bad.acao, null);
});

test('login CSRF: an attacker-owned state or proof cannot log the victim into the attacker\'s session', async () => {
  const w = await makeWorld({ allowlist: [OWNER, ATTACKER] });

  // The attacker completes their own sign-in as far as the exchange:
  // their verified state is bound to their own pre-auth cookie.
  const attackerBrowser = new BrowserSession(w);
  const attack = await honestSignIn(w, { address: ATTACKER, browser: attackerBrowser, redeem: false });
  const attackExchange = await w.app.handleExchange(
    { proof: attack.verified.proof, state: attack.verified.state }, SERVICE_ORIGIN);
  assert.equal(attackExchange.status, 200);

  // The victim begins their own sign-in (own browser, own cookie) but
  // never finishes.
  const victimBrowser = new BrowserSession(w);
  const victimStart = await w.app.startSignIn(null);

  // Attack: the victim's browser is lured to the completion URL. It
  // carries the victim's cookie, which has no verified state, so no
  // session is created - and certainly not the attacker's.
  const victimComplete = await w.app.handleComplete(`pre=${victimStart.cookieValue}`);
  assert.equal(victimComplete.status, 401);

  // Even replaying the attacker's proof+state through the victim's
  // completion cannot bind: the state was consumed to the attacker's
  // cookie only, and the proof cannot be redeemed twice.
  const replayExchange = await w.app.handleExchange(
    { proof: attack.verified.proof, state: attack.verified.state }, SERVICE_ORIGIN);
  assert.equal(replayExchange.body.error, 'replayed');
  const victimComplete2 = await w.app.handleComplete(`pre=${victimStart.cookieValue}`);
  assert.equal(victimComplete2.status, 401);

  // Sanity: the attacker's own completion works, proving the block is
  // the cookie binding, not a broken flow.
  const ownComplete = await w.app.handleComplete(`pre=${attack.start.cookieValue}`);
  assert.equal(ownComplete.status, 200);
  assert.equal(ownComplete.body.sub, ATTACKER);
});

test('a verified state expires: the bounded exchange window is 60 seconds', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const ok = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
  assert.equal(ok.status, 200);
  w.advance(61_000);
  const late = await w.app.handleComplete(`pre=${r.start.cookieValue}`);
  assert.equal(late.status, 401, 'stale verified state is not completable');
});

test('completion window boundary: 59,999 ms after verification succeeds; 60,000 and 60,001 reject', async () => {
  for (const [ms, ok] of [[59_999, true], [60_000, false], [60_001, false]]) {
    const w = await makeWorld();
    const r = await honestSignIn(w, { redeem: false });
    const exchange = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
    assert.equal(exchange.status, 200, 'setup exchange');
    w.advance(ms);
    const complete = await w.app.handleComplete(`pre=${r.start.cookieValue}`);
    assert.equal(complete.status === 200, ok, `completion at +${ms} ms`);
  }
});

// Real-browser check. Skipped unless SALUTANT_BROWSER names an engine
// ("webkit" or "chromium"); when set, a missing Playwright, a missing
// engine or any failed step fails the test. The page is served over
// https from the same worker the other tests use, with a throwaway
// certificate made in a temporary folder at run time. Only the app's
// callback is stubbed. The service cookie goes through the real browser.
const ENGINE = process.env.SALUTANT_BROWSER;
test('real browser: sign-in works and the browser keeps and returns the service cookie',
  { skip: ENGINE ? false : 'set SALUTANT_BROWSER=webkit or chromium to run' }, async () => {
    const playwright = await import('playwright');
    const launcher = playwright[ENGINE];
    assert.ok(launcher, `unknown engine: ${ENGINE}`);
    const dir = mkdtempSync(join(tmpdir(), 'salutant-cert-'));
    const w = await makeWorld();
    let server; let browser;
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
      server = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) },
        async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const hasBody = !['GET', 'HEAD'].includes(req.method);
          const out = await w.worker.fetch(new Request(`https://localhost:${server.address().port}${req.url}`, {
            method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined,
          }));
          const cookies = out.headers.getSetCookie();
          for (const [k, v] of out.headers) if (k !== 'set-cookie') res.setHeader(k, v);
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.statusCode = out.status;
          res.end(Buffer.from(await out.arrayBuffer()));
        });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const origin = `https://localhost:${server.address().port}`;
      browser = await launcher.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.route(`${APP_ORIGIN}/**`, (route) => route.fulfill({
        status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin },
        body: JSON.stringify({ completeUrl: `${origin}/done` }),
      }));
      const problems = [];
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${m.text()} @ ${m.location().url}`); });
      await page.goto(`${origin}/?app=${encodeURIComponent(APP_ORIGIN)}&state=${'x'.repeat(24)}`);
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
      await page.click('#code-form button');
      assert.equal((await verified).status(), 200, 'verify only succeeds if the cookie came back');
      await page.waitForURL(`${origin}/done`);
      assert.deepEqual(problems.filter((t) => /content security policy/i.test(t)), [], 'no policy violations');
      // Same flow again, but the browser's cookies are dropped before
      // the code is entered: the right code alone is refused.
      await page.goto(`${origin}/?app=${encodeURIComponent(APP_ORIGIN)}&state=${'y'.repeat(24)}`);
      await page.fill('#address', OWNER);
      await page.click('#address-form button');
      await page.waitForSelector('#code-form:not([hidden])');
      await w.service.drain();
      await context.clearCookies();
      await page.fill('#code', w.mailer.lastCode());
      await page.click('#code-form button');
      await page.waitForFunction(() => document.getElementById('message').textContent.includes('did not work'));
      assert.ok(page.url().startsWith(`${origin}/?app=`), 'still on the sign-in page');
    } finally {
      if (browser) await browser.close();
      if (server) server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
