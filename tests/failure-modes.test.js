// R5 closed on failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockMailAdapter } from '../src/mail-mock.js';
import { makeWorld, BrowserSession, OWNER } from './helpers.js';

test('an uncertain send is not retried, counts against budget, and is reconciled', async () => {
  const w = await makeWorld({ mailerBehavior: 'uncertain' });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  await browser.postChallenge({ address: OWNER, stateId: start.stateId });
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 1, 'no automatic retry');
  assert.equal(w.mailer.reconciliations.length, 1, 'reconciled against the provider record');
  const reservation = w.store.transact((s) => s.getRef([...s.keysWithPrefix('reservation:')][0]));
  assert.equal(reservation.outcome, 'uncertain');
  const sentDay = w.store.transact((s) => s.getRef('counter:sendday:' + Object.keys(Object.fromEntries(s.records)).find(() => true)));
  assert.ok(w.store.keysWithPrefix('counter:sendday:').length === 1, 'budget counted');
});

test('a failed send means no proof and a recorded reservation', async () => {
  const w = await makeWorld({ mailerBehavior: 'failed' });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const reservation = w.store.transact((s) => s.getRef(`reservation:${created.requestId}`));
  assert.equal(reservation.outcome, 'failed');
  // The person can still retry after the cooldown: service stays up.
  w.advance(61_000);
  const res = await browser.resend({ challengeId: created.challengeId, address: OWNER });
  assert.ok([200, 429].includes(res.status));
});

test('a double-click is one request', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const key = 'click-123';
  const [r1, r2] = await Promise.all([
    browser.postChallenge({ address: OWNER, stateId: start.stateId, idempotencyKey: key }),
    browser.postChallenge({ address: OWNER, stateId: start.stateId, idempotencyKey: key }),
  ]);
  await w.service.drain();
  const [b1, b2] = [await r1.json(), await r2.json()];
  assert.equal(b1.requestId, b2.requestId);
  assert.equal(b1.challengeId, b2.challengeId);
  assert.equal(w.mailer.outbox.length, 1, 'one mail for one logical request');
  assert.equal(w.store.keysWithPrefix('challenge:').length, 1);
});

test('a storage failure closes the service: no send, plain message', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const realTransact = w.store.transact.bind(w.store);
  w.store.transact = () => { throw new Error('storage gone'); };
  const res = await browser.postChallenge({ address: OWNER, stateId: start.stateId });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'unavailable' });
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 0, 'nothing sent when the reservation write fails');
  w.store.transact = realTransact;
});

test('an unreadable epoch closes every route', async () => {
  const w = await makeWorld();
  w.epoch.available = false;
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  for (const res of [
    await browser.postChallenge({ address: OWNER, stateId: start.stateId }),
    await browser.verify({ challengeId: 'x', code: '000000', address: OWNER }),
    await w.service.fetch(new Request('https://salutant.example.test/.well-known/jwks.json')),
  ]) {
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'unavailable' });
  }
});

test('provider timeout: the person can resend after the cooldown and sign in', async () => {
  let call = 0;
  const w = await makeWorld({ mailerBehavior: () => (++call === 1 ? 'uncertain' : 'accepted') });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 1);
  w.advance(61_000);
  await browser.resend({ challengeId: created.challengeId, address: OWNER });
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 2, 'a person-driven resend, not an automatic retry');
  const code = w.mailer.lastCode();
  const ok = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  const verified = await ok.json();
  assert.ok(verified.proof);
  // The resent code must complete the whole sign-in: the exchange
  // window runs from proof issuance, so a resend after the 60s
  // cooldown is not shut out.
  const exchange = await w.app.handleExchange(
    { proof: verified.proof, state: verified.state }, 'https://salutant.example.test');
  assert.equal(exchange.status, 200, 'resent proof exchanges');
  const complete = await w.app.handleComplete(`pre=${start.cookieValue}`);
  assert.equal(complete.status, 200, 'resent sign-in completes');
});

test('a failed send cannot verify: the undelivered code is dead on arrival', async () => {
  let captured;
  const w = await makeWorld({
    mailerBehavior: ({ text }) => { captured = text.match(/\d{6}/)[0]; return 'failed'; },
  });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const reservation = w.store.transact((s) => s.getRef(`reservation:${created.requestId}`));
  assert.equal(reservation.outcome, 'failed');
  // Even with the exact code in hand, verify issues no proof: the send
  // failed, so the reservation was never delivered (R5).
  const res = await browser.verify({ challengeId: created.challengeId, code: captured, address: OWNER });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
});

test('an idempotent replay carries the binding cookie, so a fresh-browser retry can verify', async () => {
  const w = await makeWorld();
  const browser1 = new BrowserSession(w);
  const browser2 = new BrowserSession(w); // the retry, after the first response was lost
  const start = await w.app.startSignIn(null);
  const key = 'retry-abc';
  await browser1.postChallenge({ address: OWNER, stateId: start.stateId, idempotencyKey: key });
  const replay = await browser2.postChallenge({ address: OWNER, stateId: start.stateId, idempotencyKey: key });
  assert.ok(replay.headers.getSetCookie().length > 0, 'replay re-sends the binding cookie');
  await w.service.drain();
  const code = w.mailer.lastCode();
  const created = await replay.json();
  const ok = await browser2.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.ok((await ok.json()).proof, 'the retrying browser is bound and can verify');
});

// Request id, send results and reconcile results follow docs/mail/mock-mail-adapter-contract.md;
// the mock's provider id format and lastCode() are the mock's own conventions.
test('mock mail adapter: request id required, accepted sends, reconcile results, last code', async () => {
  const mail = new MockMailAdapter();
  assert.equal(mail.lastCode(), undefined, 'no code before any send');
  await assert.rejects(() => mail.send({ to: OWNER, subject: 's', text: 't' }), /requestId is required/);
  assert.equal(mail.attempts.length, 0, 'a call without a request id records nothing');
  const first = await mail.send({ requestId: 'r1', to: OWNER, subject: 's1', text: 'code 123456' });
  const second = await mail.send({ requestId: 'r2', to: OWNER, subject: 's2', text: 'no code here' });
  assert.deepEqual(first, { outcome: 'accepted', providerId: 'mock-1' }, 'default behavior accepts');
  assert.deepEqual(second, { outcome: 'accepted', providerId: 'mock-2' });
  assert.deepEqual(mail.attempts.map((a) => [a.requestId, a.outcome]), [['r1', 'accepted'], ['r2', 'accepted']]);
  assert.deepEqual(await mail.reconcile('r2'), { state: 'sent', providerId: second.providerId });
  assert.deepEqual(await mail.reconcile('r1'), { state: 'sent', providerId: first.providerId });
  assert.deepEqual(await mail.reconcile('r3'), { state: 'absent' });
  assert.deepEqual(mail.reconciliations, ['r2', 'r1', 'r3']);
  assert.equal(mail.lastCode(), undefined, 'the last message has no six-digit code');
  await mail.send({ requestId: 'r4', to: OWNER, subject: 's4', text: 'code 654321' });
  assert.equal(mail.lastCode(), '654321');
});

// R5: sending fails after the reservation is written. The provider is called
// once and reports failure; repeating the same request (same idempotency key)
// returns the same answer and sends nothing. The existing test 'a failed send
// cannot verify' already covers the refused code; it is asserted again here
// only so one test shows the whole sequence.
test('after a failed send the provider is called once, and repeating the same request sends nothing', async () => {
  let sentCode;
  const w = await makeWorld({
    mailerBehavior: ({ text }) => {
      sentCode = text.match(/\b(\d{6})\b/)[1];
      return 'failed';
    },
  });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const key = 'failed-send-key-1';
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId, idempotencyKey: key })).json();
  await w.service.drain();
  const reservation = w.store.transact((s) => s.getRef(`reservation:${created.requestId}`));
  assert.equal(reservation.outcome, 'failed');
  assert.equal(w.mailer.attempts.length, 1, 'the provider was called once');
  const res = await browser.verify({ challengeId: created.challengeId, code: sentCode, address: OWNER });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' }, 'the undelivered code is refused');
  const replay = await new BrowserSession(w).postChallenge({ address: OWNER, stateId: start.stateId, idempotencyKey: key });
  assert.equal((await replay.json()).requestId, created.requestId);
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 1, 'the replay sent nothing');
});
