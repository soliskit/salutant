// Sign-in flow guards: the fail-closed epoch check (R14), challenge
// request validation (R2/R6), send reconciliation (R5: acceptance is
// not delivery), the attempt budget, and the app's pre-auth cookie
// binding. Guards only - no sign-in behavior is changed by these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, OWNER, APP_ORIGIN, SERVICE_ORIGIN } from './helpers.js';
import { generateSigningKeyPair } from '../src/crypto.js';

test('an epoch value that is not a safe non-negative integer keeps the service closed', async () => {
  // Distinct from the restore drills: the source answers, but its value
  // cannot be trusted (R14 - fail closed, 500, nothing else disclosed).
  for (const bad of [1.5, -2]) {
    const w = await makeWorld();
    w.epoch.value = bad;
    const browser = new BrowserSession(w);
    const start = await w.app.startSignIn(null);
    const res = await browser.postChallenge({ address: OWNER, stateId: start.stateId });
    assert.equal(res.status, 500, `epoch ${bad}`);
    assert.deepEqual(await res.json(), { error: 'unavailable' });
    assert.ok(w.logSink.some((e) => e.event === 'internal_error' && e.outcome === 'closed'),
      `epoch ${bad}: the closure is logged without detail`);
  }
});

test('a challenge request with a non-string address is rejected as a bad request', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const res = await browser.postChallenge({ address: 42, stateId: start.stateId });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request' });
  assert.ok(w.logSink.some((e) => e.event === 'challenge' && e.outcome === 'rejected_request'));
  assert.equal(w.mailer.attempts.length, 0, 'no mail is attempted for a malformed request');
});

test('an uncertain send that the provider did accept reconciles to sent, and the code then verifies', async () => {
  // The provider accepted the message but its answer was lost: the send
  // reports uncertain while the provider record holds it (R5).
  let mailer = null;
  const w = await makeWorld({
    mailerBehavior: (m) => {
      mailer.outbox.push({ ...m, providerId: `mock-late-${mailer.outbox.length + 1}`, acceptedAt: Date.now() });
      return 'uncertain';
    },
  });
  mailer = w.mailer;
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  assert.equal(w.mailer.reconciliations.length, 1, 'uncertain send is reconciled');
  const reservation = w.store.transact((s) => s.getRef(`reservation:${created.requestId}`));
  assert.equal(reservation.outcome, 'uncertain');
  assert.equal(reservation.reconciled, 'sent', 'provider record wins over the lost answer');
  // A code known to be delivered may be tried (R5): sign-in completes.
  const verify = await browser.verify({ challengeId: created.challengeId, code: w.mailer.lastCode(), address: OWNER });
  const verified = await verify.json();
  assert.ok(verified.proof, 'proof issued for the reconciled send');
  assert.equal(verified.callbackUrl, `${APP_ORIGIN}/auth/callback`);
});

test('a zero attempt budget refuses even the right code and kills the challenge on first contact', async () => {
  const w = await makeWorld({ config: { maxAttempts: 0 } });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const res = await browser.verify({ challengeId: created.challengeId, code: w.mailer.lastCode(), address: OWNER });
  // R2: the refusal is the same generic answer as any failed verify.
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
  const challenge = w.store.transact((s) => s.getRef(`challenge:${created.challengeId}`));
  assert.equal(challenge.state, 'dead');
  assert.equal(challenge.attempts, 0, 'the budget, not a wrong try, ended it');
  assert.ok(w.logSink.some((e) => e.event === 'verify' && e.outcome === 'rejected'));
  assert.ok(!w.logSink.some((e) => e.event === 'verify' && e.outcome === 'proof_issued'));
});

test('a returning browser keeps its pre-auth cookie: no fresh cookie is set', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn('returning-cookie-value-0000');
  assert.equal(start.setCookie, null, 'an existing cookie is never replaced');
  assert.equal(start.cookieValue, 'returning-cookie-value-0000', 'the presented cookie binds the state');
  const pending = w.appStore.get(`state:${start.stateId}`);
  assert.ok(pending, 'pending state stored for the returning cookie');
  assert.equal(pending.consumed, false);
  assert.equal(pending.verifiedSub, null);
});

test('a resend naming a non-string address is answered like any resend, but sends nothing', async () => {
  // R2/R3: the response shape stays uniform with fabricated ids, and no
  // mail or state movement follows from the malformed field.
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const res = await browser.resend({ challengeId: created.challengeId, address: 42 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.notEqual(body.challengeId, created.challengeId, 'fabricated id, not the real challenge');
  assert.equal(w.mailer.attempts.length, 1, 'only the original send happened');
  // The real challenge is untouched: its code still verifies.
  const verify = await browser.verify({ challengeId: created.challengeId, code: w.mailer.lastCode(), address: OWNER });
  assert.ok((await verify.json()).proof);
});

test('a verify with non-string fields is one counted wrong try, answered generically', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const res = await browser.verify({ challengeId: created.challengeId, code: 123456, address: 42 });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' }); // R2 generic
  const challenge = w.store.transact((s) => s.getRef(`challenge:${created.challengeId}`));
  assert.equal(challenge.attempts, 1, 'one wrong try counted');
  assert.equal(challenge.state, 'open', 'one try does not kill the challenge');
});

test('a revoked signing key is never published in the key listing', async () => {
  const w = await makeWorld();
  w.service.signingKeys.get('k1').status = 'revoked';
  const bare = await (await w.service.fetch(new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`))).json();
  assert.deepEqual(bare.keys, [], 'the only key is revoked');
  // A current key still publishes; the revoked one stays absent.
  const k2 = await generateSigningKeyPair();
  w.service.signingKeys.set('k2', { ...k2, status: 'current', notAfterMs: null });
  const listed = await (await w.service.fetch(new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`))).json();
  assert.deepEqual(listed.keys.map((k) => k.kid), ['k2']);
});
