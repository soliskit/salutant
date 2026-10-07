// R16 browser protocol and the required cross-site login-CSRF mock test
// (contract: Callback protocol).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, honestSignIn, OWNER, ATTACKER, SERVICE_ORIGIN, APP_ORIGIN } from './helpers.js';

test('end to end: address, code, proof, exchange, session - with third-party cookies blocked', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  browser.blockThirdPartyCookies = true; // sign-in must not depend on them
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
  const res = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state.slice(0, -1) + 'Z' }, SERVICE_ORIGIN);
  assert.notEqual(res.status, 200);
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
