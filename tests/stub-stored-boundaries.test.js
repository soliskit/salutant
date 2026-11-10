// Local stored-record boundary checks for R5 and the R14 rehearsal surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, honestSignIn, SERVICE_ORIGIN } from './helpers.js';

test('nullish stored states fail completion before a session is created [R5]', async () => {
  for (const value of [null, undefined]) {
    const w = await makeWorld();
    const start = await w.app.startSignIn(null);
    w.appStore.set(`state:${start.stateId}`, value);
    await assert.rejects(
      w.app.handleComplete(`pre=${start.cookieValue}`),
      TypeError
    );
    assert.deepEqual(w.appStore.keysWithPrefix('session:'), []);
  }
});

test('a truthy primitive state fails at the original exchange write point [R5]', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  w.appStore.set(`state:${r.start.stateId}`, true);
  await assert.rejects(
    w.app.handleExchange(
      { proof: r.verified.proof, state: r.verified.state },
      SERVICE_ORIGIN
    ),
    TypeError
  );
  assert.equal(w.appStore.keysWithPrefix('redemption:').length, 1);
  assert.deepEqual(w.appStore.keysWithPrefix('session:'), []);
  assert.equal(w.appStore.get(`state:${r.start.stateId}`), true);
});

test('a non-string stored cookie HMAC fails at decoder use before session creation [R5]', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const pending = w.appStore.getRef(`state:${start.stateId}`);
  pending.cookieHmac = 7;
  await assert.rejects(
    w.app.handleComplete(`pre=${start.cookieValue}`),
    TypeError
  );
  assert.deepEqual(w.appStore.keysWithPrefix('session:'), []);
});

test('completion retains unknown stored identity and epoch fields without asserting their types', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const exchange = await w.app.handleExchange(
    { proof: r.verified.proof, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(exchange.status, 200);
  const pending = w.appStore.getRef(`state:${r.start.stateId}`);
  pending.verifiedSub = 7;
  pending.verifiedEpoch = '2';
  pending.verifiedAtMs = String(w.getNow());
  const complete = await w.app.handleComplete(`pre=${r.start.cookieValue}`);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.sub, 7);
  const session = w.appStore.get(`session:${complete.body.sessionId}`);
  assert.equal(session.sub, 7);
  assert.equal(session.epoch, '2');
  assert.equal(w.appStore.getRef(`state:${r.start.stateId}`), pending);
  assert.equal(pending.consumed, true);
});
