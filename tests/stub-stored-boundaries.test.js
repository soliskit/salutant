// Local stored-record boundary checks for R5 and the R14 rehearsal surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, honestSignIn, SERVICE_ORIGIN } from './helpers.js';

// Narrow a stored record to an object that carries the members the test
// then reads or overwrites. The test fails here, rather than at a later
// property read, if the record is missing or not an object.
/** @param {unknown} value */
function pendingRecord(value) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'cookieHmac' in value &&
      'verifiedSub' in value &&
      'consumed' in value
  );
  return value;
}

/** @param {unknown} value */
function verifiedRecord(value) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'cookieHmac' in value &&
      'verifiedSub' in value &&
      'verifiedEpoch' in value &&
      'verifiedAtMs' in value &&
      'consumed' in value
  );
  return value;
}

/** @param {unknown} value */
function sessionRecord(value) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'sub' in value &&
      'epoch' in value
  );
  return value;
}

void test('nullish stored states fail completion before a session is created [R5]', async () => {
  for (const value of [null, undefined]) {
    const w = await makeWorld();
    const start = await w.app.startSignIn(null);
    w.appStore.set(`state:${start.stateId}`, value);
    await assert.rejects(
      Promise.resolve(w.app.handleComplete(`pre=${start.cookieValue}`)),
      TypeError
    );
    assert.deepEqual(w.appStore.keysWithPrefix('session:'), []);
  }
});

void test('a truthy primitive state fails at the original exchange write point [R5]', async () => {
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

void test('a non-string stored cookie HMAC fails at decoder use before session creation [R5]', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const pending = pendingRecord(w.appStore.getRef(`state:${start.stateId}`));
  pending.cookieHmac = 7;
  await assert.rejects(
    Promise.resolve(w.app.handleComplete(`pre=${start.cookieValue}`)),
    TypeError
  );
  assert.deepEqual(w.appStore.keysWithPrefix('session:'), []);
});

void test('completion retains unknown stored identity and epoch fields without asserting their types', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const exchange = await w.app.handleExchange(
    { proof: r.verified.proof, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(exchange.status, 200);
  const pending = verifiedRecord(w.appStore.getRef(`state:${r.start.stateId}`));
  pending.verifiedSub = 7;
  pending.verifiedEpoch = '2';
  pending.verifiedAtMs = String(w.getNow());
  const complete = await w.app.handleComplete(`pre=${r.start.cookieValue}`);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.sub, 7);
  const session = sessionRecord(
    w.appStore.get(`session:${complete.body.sessionId}`)
  );
  assert.equal(session.sub, 7);
  assert.equal(session.epoch, '2');
  assert.equal(w.appStore.getRef(`state:${r.start.stateId}`), pending);
  assert.equal(pending.consumed, true);
});
