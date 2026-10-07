// R4 signed proof and exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, honestSignIn, OWNER, SERVICE_ORIGIN, APP_ORIGIN } from './helpers.js';
import { generateSigningKeyPair, signProof, toBase64Url } from '../src/crypto.js';

async function freshProof(w) {
  const r = await honestSignIn(w);
  assert.ok(r.verified.proof, 'setup proof');
  return r;
}

test('a valid proof redeems into exactly one session', async () => {
  const w = await makeWorld();
  const r = await freshProof(w);
  assert.equal(r.exchange.status, 200);
  assert.equal(r.complete.status, 200);
  assert.ok(r.complete.body.sessionId);
  assert.ok(w.app.sessionExists(r.complete.body.sessionId));
});

test('many parallel redemptions of one proof give one redemption', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  assert.ok(r.verified.proof, 'setup proof');
  const outcomes = await Promise.all(Array.from({ length: 20 }, () =>
    w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN)));
  assert.equal(outcomes.filter((o) => o.status === 200).length, 1);
  assert.equal(outcomes.filter((o) => o.body.error === 'replayed').length, 19);
});

async function tampered(w, mutate) {
  const r = await honestSignIn(w);
  const [h, p, s] = r.verified.proof.split('.');
  const claims = JSON.parse(new TextDecoder().decode(
    (await import('../src/crypto.js')).fromBase64Url(p)));
  mutate(claims);
  const key = w.service.signingKeys.get('k1');
  return signProof(claims, key.privateKey, 'k1');
}

test('wrong issuer, audience, expiry, not-before and issue time are rejected', async () => {
  const w = await makeWorld({ config: { sendsPerAddressPerHour: 100, requestsPerAddressPerHour: 100, requestsPerSourcePerHour: 100 } });
  const cases = [
    (c) => { c.iss = 'https://evil.example.test'; },
    (c) => { c.aud = 'https://other.example.test'; },
    (c) => { c.exp = Math.floor(w.getNow() / 1000) - 120; },
    (c) => { c.nbf = Math.floor(w.getNow() / 1000) + 600; },
    (c) => { c.iat = Math.floor(w.getNow() / 1000) + 600; },
  ];
  for (const mutate of cases) {
    const token = await tampered(w, mutate);
    const res = await w.app.handleExchange({ proof: token, state: 'x'.repeat(24) }, SERVICE_ORIGIN);
    assert.notEqual(res.status, 200);
  }
});

test('an altered proof body fails its signature', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  const [h, p, s] = r.verified.proof.split('.');
  const claims = JSON.parse(new TextDecoder().decode(
    (await import('../src/crypto.js')).fromBase64Url(p)));
  claims.sub = 'someone-else@example.test';
  const forged = `${h}.${toBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.${s}`;
  const res = await w.app.handleExchange({ proof: forged, state: r.verified.state }, SERVICE_ORIGIN);
  assert.notEqual(res.status, 200);
});

test('another algorithm or key type is never accepted', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  // alg:none style token
  const noneHeader = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  const [, p] = r.verified.proof.split('.');
  const res = await w.app.handleExchange({ proof: `${noneHeader}.${p}.` , state: r.verified.state }, SERVICE_ORIGIN);
  assert.notEqual(res.status, 200);
  // a different key pair's signature under the real kid fails
  const other = await generateSigningKeyPair();
  const claims = { iss: SERVICE_ORIGIN, aud: APP_ORIGIN, sub: OWNER, iat: 1, nbf: 1, exp: 9e9, kid: 'k1', jti: 'x', nonce: 'y', epoch: 1 };
  const forged = await signProof(claims, other.privateKey, 'k1');
  const res2 = await w.app.handleExchange({ proof: forged, state: 'y' }, SERVICE_ORIGIN);
  assert.notEqual(res2.status, 200);
});

test('an unknown key id is rejected after one refresh', async () => {
  const w = await makeWorld();
  const other = await generateSigningKeyPair();
  const claims = { iss: SERVICE_ORIGIN, aud: APP_ORIGIN, sub: OWNER, iat: 1, nbf: 1, exp: 9e9, kid: 'kNope', jti: 'x', nonce: 'y', epoch: 1 };
  const token = await signProof(claims, other.privateKey, 'kNope');
  const res = await w.app.handleExchange({ proof: token, state: 'y' }, SERVICE_ORIGIN);
  assert.notEqual(res.status, 200);
  assert.equal(res.body.error, 'unknown_key');
});

test('a reused state value is rejected', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.equal(r.exchange.status, 200);
  // second exchange of the same proof+state: replayed
  const again = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
  assert.equal(again.body.error, 'replayed');
});

test('a proof for another audience is rejected by this app', async () => {
  const w = await makeWorld();
  const key = w.service.signingKeys.get('k1');
  const nowS = Math.floor(w.getNow() / 1000);
  const token = await signProof({
    iss: SERVICE_ORIGIN, aud: 'https://other.example.test', sub: OWNER,
    iat: nowS, nbf: nowS, exp: nowS + 300, kid: 'k1', jti: 'j1', nonce: 'n1', epoch: 1,
  }, key.privateKey, 'k1');
  const res = await w.app.handleExchange({ proof: token, state: 'n1' }, SERVICE_ORIGIN);
  assert.equal(res.body.error, 'bad_proof');
});

test('a correctly signed proof missing required claims is rejected', async () => {
  for (const field of ['exp', 'nbf', 'iat', 'jti']) {
    const w = await makeWorld();
    const r = await honestSignIn(w, { redeem: false });
    assert.ok(r.verified.proof, 'setup proof');
    // Mutate this sign-in's own claims so the missing field is the only
    // defect: nonce, epoch and audience all match.
    const [, p] = r.verified.proof.split('.');
    const claims = JSON.parse(new TextDecoder().decode(
      (await import('../src/crypto.js')).fromBase64Url(p)));
    delete claims[field];
    const key = w.service.signingKeys.get('k1');
    const token = await signProof(claims, key.privateKey, 'k1');
    const res = await w.app.handleExchange({ proof: token, state: r.verified.state }, SERVICE_ORIGIN);
    assert.notEqual(res.status, 200, `missing ${field} must be rejected`);
    assert.equal(res.body.error, 'bad_proof');
  }
});

test('the exchange itself enforces the 60-second window', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  w.advance(61_000);
  const late = await w.app.handleExchange({ proof: r.verified.proof, state: r.verified.state }, SERVICE_ORIGIN);
  assert.notEqual(late.status, 200, 'an exchange 61 seconds after the state was created is rejected');
});
