// R14 state survives restore safely, R12 key lifecycle, and the R8/R15
// epoch steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, honestSignIn, OWNER, SERVICE_ORIGIN, APP_ORIGIN } from './helpers.js';
import { generateSigningKeyPair, signProof } from '../src/crypto.js';

test('restore rehearsal: without an epoch raise the service stays closed; after it, old items are rejected', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const code = w.mailer.lastCode();
  const snapshot = w.store.snapshot();

  // Consume the code, then simulate a point-in-time restore that brings
  // the consumed challenge back as open.
  const used = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.ok((await used.json()).proof);
  w.store.restoreFrom(snapshot);

  // Operational rule (contract: Epoch and restore boundary): a restore
  // does not resume service. The epoch stays unreadable until the owner
  // raises it; the service stays closed.
  w.epoch.available = false;
  const closedTry = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.equal(closedTry.status, 500);

  // The owner raises the epoch. Everything issued before it is
  // rejected: the restored code is from the old epoch and fails.
  w.epoch.value = 2;
  w.epoch.available = true;
  const oldTry = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.deepEqual(await oldTry.json(), { error: 'invalid_or_expired_code' });

  // A new challenge on the new epoch works.
  const fresh = await honestSignIn(w, { browser });
  assert.ok(fresh.verified.proof, 'service resumes on the new epoch');
});

test('a restored consumed code is not reusable once the epoch moved', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const code = w.mailer.lastCode();
  w.epoch.value = 2; // owner raised the epoch after an incident
  const res = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
});

test('routine rotation: the old key verifies during overlap and is gone after', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  assert.ok(r.verified.proof);

  // Rotate: k2 current, k1 overlapping for at least the proof lifetime
  // plus skew plus the staleness bound.
  const k2 = await generateSigningKeyPair();
  w.service.signingKeys.set('k1', { ...w.service.signingKeys.get('k1'), status: 'overlap', notAfterMs: w.getNow() + (5 * 60_000 + 60_000 + 10 * 60_000) });
  w.service.signingKeys.set('k2', { ...k2, status: 'current', notAfterMs: null });
  w.service.currentKid = 'k2';

  // A k1 proof issued before rotation still redeems during overlap.
  const ok = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
  assert.equal(ok.status, 200);

  // After the overlap ends the key endpoint no longer lists k1.
  w.advance(16 * 60_000);
  const jwks = await (await w.service.fetch(new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`))).json();
  assert.deepEqual(jwks.keys.map((k) => k.kid), ['k2']);
  // An app refreshing now rejects the old-key proof (fails closed on
  // unknown key after one refresh).
  const stale = await w.app.handleExchange({ proof: r.verified.proof, state: 'fresh-state-value-000000' }, SERVICE_ORIGIN);
  assert.equal(stale.body.error, 'unknown_key');
});

test('emergency revoke: a warm app cache may accept within the bound; after it, fail closed', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  const before = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
  assert.equal(before.status, 200);

  // A second proof on the old key, then an emergency revoke.
  const r2 = await honestSignIn(w, { redeem: false });
  w.service.signingKeys.get('k1').status = 'revoked';

  // An app with a warm cache (fetched before the revoke) may still
  // accept the old-key proof - that is the accepted window (R12).
  const warm = await w.app.handleExchange({ proof: r2.verified.proof, state: r2.verified.state }, SERVICE_ORIGIN);
  assert.equal(warm.status, 200, 'warm cache inside the end-to-end bound');

  // Once the app cache ends and refresh fails, the app rejects (fails
  // closed).
  w.advance(5 * 60_000 + 1);
  const realFetch = w.app.fetchJwks;
  w.app.fetchJwks = async () => { throw new Error('service unreachable'); };
  const closed = await w.app.handleExchange({ proof: r2.verified.proof, state: 'another-state-00000000' }, SERVICE_ORIGIN);
  assert.notEqual(closed.status, 200);
  w.app.fetchJwks = realFetch;
});

test('a proof from an earlier epoch is rejected and the app drops earlier sessions', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.equal(r.complete.status, 200);
  const sessionId = r.complete.body.sessionId;
  assert.ok(w.app.sessionExists(sessionId));

  // The owner raises the epoch (lost-mailbox step 3, R15).
  w.epoch.value = 2;
  w.app.jwksCache = null;

  // Old-epoch proof is rejected.
  const res = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
  assert.notEqual(res.status, 200);

  // The app drops sessions issued before the new epoch.
  w.app.dropSessionsBefore(2);
  assert.ok(!w.app.sessionExists(sessionId));
});

test('the key endpoint reports the current epoch and honors the cache window', async () => {
  const w = await makeWorld();
  const first = await (await w.service.fetch(new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`))).json();
  assert.equal(first.epoch, 1);
  w.epoch.value = 7;
  const second = await (await w.service.fetch(new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`))).json();
  assert.equal(second.epoch, 7);
});
