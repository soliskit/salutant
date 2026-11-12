// R14 state survives restore safely, R12 key lifecycle, and the R8/R15
// epoch steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/storage.js';
import { DurableObjectStore } from '../src/do-store.js';
import { generateSigningKeyPair } from '../src/crypto.js';
import {
  makeWorld,
  makeDOStorage,
  BrowserSession,
  honestSignIn,
  OWNER,
  SERVICE_ORIGIN,
  readCreated
} from './helpers.js';

// The plan requires the storage-exercising suite to run against both
// store drivers: MemoryStore (local twin) and DurableObjectStore (the
// production binding), so storage behavior is proven against the same
// interface the worker will use.
/**
 * @typedef {import('../src/service.js').ServiceStore & {
 *   snapshot(): string,
 *   restoreFrom(snapshot: string): void
 * }} DriverStore
 */
/** @type {Array<[string, () => DriverStore]>} */
const DRIVERS = [
  ['MemoryStore', () => new MemoryStore()],
  ['DurableObjectStore', () => new DurableObjectStore(makeDOStorage())]
];
// Narrow a stored record to an object that carries the members the test
// then reads, so the test fails here, not at a later read, if the record
// is missing or not an object. The member values stay unknown.
/** @param {unknown} value */
function challengeRecord(value) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'listed' in value &&
      'state' in value &&
      'attempts' in value &&
      'epoch' in value &&
      'expiresAtMs' in value &&
      'requestId' in value
  );
  return value;
}

/** @param {unknown} value */
function reservationRecord(value) {
  assert.ok(typeof value === 'object' && value !== null && 'outcome' in value);
  return value;
}

/** @param {string} snap */
const sortedEntries = (snap) =>
  JSON.parse(snap).sort(([a], [b]) => (a < b ? -1 : 1));

for (const [driver, storeFactory] of DRIVERS) {
  void test(`[${driver}] restore rehearsal: without an epoch raise the service stays closed; after it, old items are rejected`, async () => {
    const w = await makeWorld({ storeFactory });
    const browser = new BrowserSession(w);
    const start = await w.app.startSignIn(null);
    const created = await readCreated(
      await browser.postChallenge({ address: OWNER, stateId: start.stateId })
    );
    await w.service.drain();
    const code = w.mailer.lastCode();
    const snapshot = w.store.snapshot();
    const beforeConsume = sortedEntries(snapshot);

    // Consume the code, then simulate a point-in-time restore that brings
    // the consumed challenge back as open.
    const used = await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    });
    assert.ok((await used.json()).proof);
    w.store.restoreFrom(snapshot);
    assert.ok(
      beforeConsume.length > 0,
      'records existed before the code was consumed'
    );
    assert.deepEqual(
      sortedEntries(w.store.snapshot()),
      beforeConsume,
      'restore brings back exactly the snapshotted records'
    );

    // Operational rule: a restore
    // does not resume service. The epoch stays unreadable until the owner
    // raises it; the service stays closed.
    w.epoch.available = false;
    const closedTry = await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    });
    assert.equal(closedTry.status, 500);

    // The owner raises the epoch. Everything issued before it is
    // rejected: the restored code is from the old epoch and fails.
    w.epoch.value = 2;
    w.epoch.available = true;
    const oldTry = await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    });
    assert.deepEqual(await oldTry.json(), { error: 'invalid_or_expired_code' });

    // A new challenge on the new epoch works.
    const fresh = await honestSignIn(w, { browser });
    assert.ok(fresh.verified.proof, 'service resumes on the new epoch');
  });

  void test(`[${driver}] an old-epoch code is refused after the epoch is raised`, async () => {
    const w = await makeWorld({ storeFactory });
    const browser = new BrowserSession(w);
    const start = await w.app.startSignIn(null);
    const created = await readCreated(
      await browser.postChallenge({ address: OWNER, stateId: start.stateId })
    );
    await w.service.drain();
    const code = w.mailer.lastCode();
    w.epoch.value = 2; // owner raised the epoch after an incident
    const res = await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    });
    assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
  });

  // R14 local fixture only: restore clears a proven wrong-try lockout.
  // The existing closed-service and raised-epoch rules must still reject it.
  // This does not test request/send counters or automatic restore detection.
  void test(`[${driver}] a restored challenge with its wrong-try lockout cleared stays refused through the restore epoch steps`, async () => {
    const w = await makeWorld({ storeFactory });
    const browser = new BrowserSession(w);
    const start = await w.app.startSignIn(null);
    const create = await browser.postChallenge({
      address: OWNER,
      stateId: start.stateId
    });
    assert.equal(create.status, 200);
    const created = await create.json();
    assert.equal(created.status, 'ok');
    assert.equal(typeof created.challengeId, 'string');
    await w.service.drain();
    const code = w.mailer.lastCode();
    assert.ok(code, 'a code was mailed');
    assert.match(code, /^\d{6}$/);
    assert.ok(
      browser.cookies.size > 0,
      'the original browser holds its binding cookie'
    );

    const challengeKey = `challenge:${created.challengeId}`;
    const original = challengeRecord(w.store.get(challengeKey));
    assert.ok(original, 'the challenge was stored');
    assert.equal(original.listed, true);
    assert.equal(original.state, 'open');
    assert.equal(original.attempts, 0);
    assert.equal(original.epoch, 1);
    assert.ok(
      typeof original.expiresAtMs === 'number',
      'the original expiry is a number'
    );
    assert.ok(
      original.expiresAtMs > w.getNow(),
      'the original code is not expired'
    );
    assert.equal(
      reservationRecord(w.store.get(`reservation:${original.requestId}`))
        .outcome,
      'accepted'
    );
    assert.equal(w.store.keysWithPrefix('issuance:').length, 0);
    const snapshot = w.store.snapshot();
    const beforeLockout = sortedEntries(snapshot);
    const maxAttempts = w.service.config.maxAttempts;
    assert.equal(
      maxAttempts,
      3,
      'this fixture uses the existing default wrong-try limit'
    );
    const wrongCode = `${String((Number(code[0]) + 1) % 10)}${code.slice(1)}`;
    assert.notEqual(
      wrongCode,
      code,
      'the wrong code differs while retaining six digits'
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await browser.verify({
        challengeId: created.challengeId,
        code: wrongCode,
        address: OWNER
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        error: 'invalid_or_expired_code'
      });
    }
    const locked = challengeRecord(w.store.get(challengeKey));
    assert.equal(locked.attempts, maxAttempts);
    assert.equal(
      locked.state,
      'dead',
      'the wrong-try lockout was reached before restore'
    );
    const lockedCorrect = await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    });
    assert.equal(lockedCorrect.status, 200);
    assert.deepEqual(await lockedCorrect.json(), {
      error: 'invalid_or_expired_code'
    });
    assert.equal(w.store.keysWithPrefix('issuance:').length, 0);

    w.store.restoreFrom(snapshot);
    assert.deepEqual(
      sortedEntries(w.store.snapshot()),
      beforeLockout,
      'restore replaces the entire stored state with the pre-lockout snapshot'
    );
    assert.deepEqual(
      w.store.get(challengeKey),
      original,
      'restore preserves the original code, browser binding, delivery, lifetime and epoch'
    );
    assert.equal(challengeRecord(w.store.get(challengeKey)).attempts, 0);
    assert.equal(
      challengeRecord(w.store.get(challengeKey)).state,
      'open',
      'restore actually cleared the lockout'
    );

    // The owner protocol makes the epoch unreadable until the owner raises it.
    // No automatic restore detection or production recovery is claimed.
    w.epoch.available = false;
    const closed = await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    });
    assert.equal(closed.status, 500);
    assert.deepEqual(await closed.json(), { error: 'unavailable' });
    assert.deepEqual(
      sortedEntries(w.store.snapshot()),
      beforeLockout,
      'the closed service did not consume or relock the restored challenge'
    );

    w.epoch.value = 2;
    w.epoch.available = true;
    assert.ok(
      w.getNow() < original.expiresAtMs,
      'expiry cannot explain the refusal'
    );
    assert.equal(
      reservationRecord(w.store.get(`reservation:${original.requestId}`))
        .outcome,
      'accepted',
      'failed mail cannot explain the refusal'
    );
    const oldEpoch = await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    });
    assert.equal(oldEpoch.status, 200);
    assert.deepEqual(await oldEpoch.json(), {
      error: 'invalid_or_expired_code'
    });
    assert.deepEqual(
      sortedEntries(w.store.snapshot()),
      beforeLockout,
      'epoch refusal leaves attempts zero, state open, and no proof issuance'
    );
    assert.equal(w.store.keysWithPrefix('issuance:').length, 0);
  });

  void test(`[${driver}] routine rotation: the old key verifies during overlap and is gone after`, async () => {
    const w = await makeWorld({ storeFactory });
    const r = await honestSignIn(w, { redeem: false });
    assert.ok(r.verified.proof);

    // Rotate: k2 current, k1 overlapping for at least the proof lifetime
    // plus skew plus the staleness bound.
    const k2 = await generateSigningKeyPair();
    w.service.signingKeys.set('k1', {
      ...w.service.signingKeys.get('k1'),
      status: 'overlap',
      notAfterMs: w.getNow() + (5 * 60_000 + 60_000 + 10 * 60_000)
    });
    w.service.signingKeys.set('k2', {
      ...k2,
      status: 'current',
      notAfterMs: null
    });
    w.service.currentKid = 'k2';

    // A k1 proof issued before rotation still redeems during overlap.
    const ok = await w.app.handleExchange(
      { proof: r.verified.proof, state: r.verified.state },
      SERVICE_ORIGIN
    );
    assert.equal(ok.status, 200);

    // After the overlap ends the key endpoint no longer lists k1.
    w.advance(16 * 60_000);
    const jwks = await (
      await w.service.fetch(
        new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`)
      )
    ).json();
    assert.deepEqual(
      jwks.keys.map((k) => k.kid),
      ['k2']
    );
    // An app refreshing now rejects the old-key proof (fails closed on
    // unknown key after one refresh).
    const stale = await w.app.handleExchange(
      { proof: r.verified.proof, state: 'fresh-state-value-000000' },
      SERVICE_ORIGIN
    );
    assert.equal(stale.body.error, 'unknown_key');
  });

  void test(`[${driver}] emergency revoke: a warm app cache may accept within the bound; after it, fail closed`, async () => {
    const w = await makeWorld({ storeFactory });
    const r = await honestSignIn(w, { redeem: false });
    const before = await w.app.handleExchange(
      { proof: r.verified.proof, state: r.verified.state },
      SERVICE_ORIGIN
    );
    assert.equal(before.status, 200);

    // A second proof on the old key, then an emergency revoke.
    const r2 = await honestSignIn(w, { redeem: false });
    const revokedKey = w.service.signingKeys.get('k1');
    assert.ok(revokedKey, 'the k1 signing key is present');
    revokedKey.status = 'revoked';

    // An app with a warm cache (fetched before the revoke) may still
    // accept the old-key proof - that is the accepted window (R12).
    const warm = await w.app.handleExchange(
      { proof: r2.verified.proof, state: r2.verified.state },
      SERVICE_ORIGIN
    );
    assert.equal(warm.status, 200, 'warm cache inside the end-to-end bound');

    // Once the app cache ends and refresh fails, the app rejects (fails
    // closed).
    w.advance(5 * 60_000 + 1);
    const realFetch = w.app.fetchJwks;
    w.app.fetchJwks = () => Promise.reject(new Error('service unreachable'));
    const closed = await w.app.handleExchange(
      { proof: r2.verified.proof, state: 'another-state-00000000' },
      SERVICE_ORIGIN
    );
    assert.notEqual(closed.status, 200);
    w.app.fetchJwks = realFetch;
  });

  void test(`[${driver}] a store restore does not bring back a revoked signing key`, async () => {
    const w = await makeWorld({ storeFactory });
    const snapshot = w.store.snapshot();
    w.store.transact((s) => {
      s.set('restore-witness', { written: true });
    });

    // Two fresh sign-ins at the current epoch: one signed by k1, then one
    // signed by k2 after k2 becomes current.
    const signedByK1 = await honestSignIn(w, { redeem: false });
    const k2 = await generateSigningKeyPair();
    w.service.signingKeys.set('k2', {
      ...k2,
      status: 'current',
      notAfterMs: null
    });
    w.service.currentKid = 'k2';
    const signedByK2 = await honestSignIn(w, { redeem: false });

    // Emergency revoke of k1, then a point-in-time restore of the records.
    const revokedKey = w.service.signingKeys.get('k1');
    assert.ok(revokedKey, 'the k1 signing key is present');
    revokedKey.status = 'revoked';
    w.store.restoreFrom(snapshot);
    assert.equal(
      w.store.transact((s) => s.get('restore-witness')),
      undefined,
      'the restore ran: a record written after the snapshot is gone'
    );
    w.app.jwksCache = null;

    const listed = await (
      await w.service.fetch(
        new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`)
      )
    ).json();
    assert.deepEqual(
      listed.keys.map((k) => k.kid),
      ['k2'],
      'the key list holds the current key and not the revoked one'
    );

    const refused = await w.app.handleExchange(
      { proof: signedByK1.verified.proof, state: signedByK1.verified.state },
      SERVICE_ORIGIN
    );
    assert.equal(refused.status, 400);
    assert.equal(
      refused.body.error,
      'unknown_key',
      'a proof from the revoked key is an unknown key'
    );
    const accepted = await w.app.handleExchange(
      { proof: signedByK2.verified.proof, state: signedByK2.verified.state },
      SERVICE_ORIGIN
    );
    assert.equal(accepted.status, 200, 'a proof from the current key works');
  });

  void test(`[${driver}] a proof from an earlier epoch is rejected and the app drops earlier sessions`, async () => {
    const w = await makeWorld({ storeFactory });
    const r = await honestSignIn(w);
    assert.ok(r.complete);
    assert.equal(r.complete.status, 200);
    const sessionId = r.complete.body.sessionId;
    assert.ok(w.app.sessionExists(sessionId));

    // The owner raises the epoch (lost-mailbox step 3, R15).
    w.epoch.value = 2;
    w.app.jwksCache = null;

    // Old-epoch proof is rejected.
    const res = await w.app.handleExchange(
      { proof: r.verified.proof, state: r.verified.state },
      SERVICE_ORIGIN
    );
    assert.notEqual(res.status, 200);

    // The app drops sessions issued before the new epoch.
    w.app.dropSessionsBefore(2);
    assert.ok(!w.app.sessionExists(sessionId));
  });

  void test(`[${driver}] the key endpoint reports the current epoch and honors the cache window`, async () => {
    const w = await makeWorld({ storeFactory });
    const first = await (
      await w.service.fetch(
        new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`)
      )
    ).json();
    assert.equal(first.epoch, 1);
    w.epoch.value = 7;
    const second = await (
      await w.service.fetch(
        new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`)
      )
    ).json();
    assert.equal(second.epoch, 7);
  });
}
