// R4 signed proof and exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeWorld,
  BrowserSession,
  honestSignIn,
  OWNER,
  SERVICE_ORIGIN,
  APP_ORIGIN,
  readCreated,
  readVerified,
  isRecord
} from './helpers.js';
import {
  generateSigningKeyPair,
  signProof,
  timingSafeEqual,
  toBase64Url,
  verifyProofSignature
} from '../src/crypto.js';

/** @param {Awaited<ReturnType<typeof makeWorld>>} w */
async function freshProof(w) {
  const r = await honestSignIn(w);
  assert.ok(r.verified.proof, 'setup proof');
  return r;
}

void test('a valid proof redeems into exactly one session', async () => {
  const w = await makeWorld();
  const r = await freshProof(w);
  assert.ok(r.exchange !== null, 'honest sign-in returned no exchange');
  assert.equal(r.exchange.status, 200);
  assert.ok(r.complete);
  assert.equal(r.complete.status, 200);
  assert.ok(r.complete.body.sessionId);
  assert.ok(w.app.sessionExists(r.complete.body.sessionId));
});

void test('many parallel redemptions of one proof give one redemption', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  assert.ok(r.verified.proof, 'setup proof');
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () =>
      w.app.handleExchange(
        { proof: r.verified.proof, state: r.verified.state },
        SERVICE_ORIGIN
      )
    )
  );
  assert.equal(outcomes.filter((o) => o.status === 200).length, 1);
  assert.equal(outcomes.filter((o) => errorOf(o) === 'replayed').length, 19);
});

// The error member of an exchange result, or undefined when the result is
// the success shape that has none.
/** @param {{ body: object }} result */
function errorOf(result) {
  return 'error' in result.body ? result.body.error : undefined;
}

// Narrow a stored sign-in state to an object that carries the members the
// test reads. Its writer (stub-app.js startSignIn) always writes stateId,
// cookieHmac, createdAtMs, verifiedSub and consumed. The test fails here,
// not at a later read, if the record is missing or not an object.
/** @param {unknown} value */
function stateRecord(value) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'verifiedSub' in value &&
      'consumed' in value
  );
  return value;
}

/**
 * @param {Awaited<ReturnType<typeof makeWorld>>} w
 * @param {(claims: Record<string, unknown>) => void} mutate
 */
async function tampered(w, mutate) {
  const r = await honestSignIn(w);
  const [, p] = r.verified.proof.split('.');
  /** @type {unknown} */
  const parsedClaims = JSON.parse(
    new TextDecoder().decode(
      (await import('../src/crypto.js')).fromBase64Url(p)
    )
  );
  assert.ok(isRecord(parsedClaims));
  const claims = parsedClaims;
  mutate(claims);
  const key = w.service.signingKeys.get('k1');
  assert.ok(key, 'the k1 signing key is present');
  return signProof(claims, key.privateKey, 'k1');
}

void test('wrong issuer, audience, expiry, not-before and issue time are rejected', async () => {
  const w = await makeWorld({
    config: {
      sendsPerAddressPer30Minutes: 100,
      requestsPerAddressPerHour: 100,
      requestsPerSourcePerHour: 100
    }
  });
  /** @type {((claims: Record<string, unknown>) => void)[]} */
  const cases = [
    (c) => {
      c.iss = 'https://evil.example.test';
    },
    (c) => {
      c.aud = 'https://other.example.test';
    },
    (c) => {
      c.exp = Math.floor(w.getNow() / 1000) - 120;
    },
    (c) => {
      c.nbf = Math.floor(w.getNow() / 1000) + 600;
    },
    (c) => {
      c.iat = Math.floor(w.getNow() / 1000) + 600;
    }
  ];
  for (const mutate of cases) {
    const token = await tampered(w, mutate);
    const res = await w.app.handleExchange(
      { proof: token, state: 'x'.repeat(24) },
      SERVICE_ORIGIN
    );
    assert.notEqual(res.status, 200);
  }
});

void test('an altered proof body fails its signature', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  const [h, p, s] = r.verified.proof.split('.');
  /** @type {unknown} */
  const parsedClaims = JSON.parse(
    new TextDecoder().decode(
      (await import('../src/crypto.js')).fromBase64Url(p)
    )
  );
  assert.ok(isRecord(parsedClaims));
  const claims = parsedClaims;
  claims.sub = 'someone-else@example.test';
  const forged = `${h}.${toBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.${s}`;
  const res = await w.app.handleExchange(
    { proof: forged, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.notEqual(res.status, 200);
});

void test('another algorithm or key type is never accepted', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  // alg:none style token
  const noneHeader = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  );
  const [, p] = r.verified.proof.split('.');
  const res = await w.app.handleExchange(
    { proof: `${noneHeader}.${p}.`, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.notEqual(res.status, 200);
  // a different key pair's signature under the real kid fails
  const other = await generateSigningKeyPair();
  const claims = {
    iss: SERVICE_ORIGIN,
    aud: APP_ORIGIN,
    sub: OWNER,
    iat: 1,
    nbf: 1,
    exp: 9e9,
    kid: 'k1',
    jti: 'x',
    nonce: 'y',
    epoch: 1
  };
  const forged = await signProof(claims, other.privateKey, 'k1');
  const res2 = await w.app.handleExchange(
    { proof: forged, state: 'y' },
    SERVICE_ORIGIN
  );
  assert.notEqual(res2.status, 200);
});

void test('an unknown key id is rejected after one refresh', async () => {
  const w = await makeWorld();
  const other = await generateSigningKeyPair();
  const claims = {
    iss: SERVICE_ORIGIN,
    aud: APP_ORIGIN,
    sub: OWNER,
    iat: 1,
    nbf: 1,
    exp: 9e9,
    kid: 'kNope',
    jti: 'x',
    nonce: 'y',
    epoch: 1
  };
  const token = await signProof(claims, other.privateKey, 'kNope');
  const res = await w.app.handleExchange(
    { proof: token, state: 'y' },
    SERVICE_ORIGIN
  );
  assert.notEqual(res.status, 200);
  assert.equal(errorOf(res), 'unknown_key');
});

void test('a reused state value is rejected', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.ok(r.exchange !== null, 'honest sign-in returned no exchange');
  assert.equal(r.exchange.status, 200);
  // second exchange of the same proof+state: replayed
  const again = await w.app.handleExchange(
    { proof: r.verified.proof, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(errorOf(again), 'replayed');
});

void test('a proof for another audience is rejected by this app', async () => {
  const w = await makeWorld();
  const key = w.service.signingKeys.get('k1');
  assert.ok(key);
  const nowS = Math.floor(w.getNow() / 1000);
  const token = await signProof(
    {
      iss: SERVICE_ORIGIN,
      aud: 'https://other.example.test',
      sub: OWNER,
      iat: nowS,
      nbf: nowS,
      exp: nowS + 300,
      kid: 'k1',
      jti: 'j1',
      nonce: 'n1',
      epoch: 1
    },
    key.privateKey,
    'k1'
  );
  const res = await w.app.handleExchange(
    { proof: token, state: 'n1' },
    SERVICE_ORIGIN
  );
  assert.equal(errorOf(res), 'bad_proof');
});

void test('a correctly signed proof missing required claims is rejected', async () => {
  for (const field of ['exp', 'nbf', 'iat', 'jti']) {
    const w = await makeWorld();
    const r = await honestSignIn(w, { redeem: false });
    assert.ok(r.verified.proof, 'setup proof');
    // Mutate this sign-in's own claims so the missing field is the only
    // defect: nonce, epoch and audience all match.
    const [, p] = r.verified.proof.split('.');
    /** @type {unknown} */
    const parsedClaims = JSON.parse(
      new TextDecoder().decode(
        (await import('../src/crypto.js')).fromBase64Url(p)
      )
    );
    assert.ok(isRecord(parsedClaims));
    const claims = Object.fromEntries(
      Object.entries(parsedClaims).filter(([key]) => key !== field)
    );
    const key = w.service.signingKeys.get('k1');
    assert.ok(key);
    const token = await signProof(claims, key.privateKey, 'k1');
    const res = await w.app.handleExchange(
      { proof: token, state: r.verified.state },
      SERVICE_ORIGIN
    );
    assert.notEqual(res.status, 200, `missing ${field} must be rejected`);
    assert.equal(errorOf(res), 'bad_proof');
  }
});

void test('a correctly signed numeric subject is rejected before identity binding', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  assert.ok(r.verified.proof, 'setup proof');
  assert.equal(
    r.verified.state,
    r.start.stateId,
    'setup state belongs to this sign-in'
  );
  const [, payload] = r.verified.proof.split('.');
  /** @type {unknown} */
  const parsedClaims = JSON.parse(
    new TextDecoder().decode(
      (await import('../src/crypto.js')).fromBase64Url(payload)
    )
  );
  assert.ok(isRecord(parsedClaims));
  const claims = parsedClaims;
  claims.sub = 123;
  const key = w.service.signingKeys.get('k1');
  assert.ok(key);
  const token = await signProof(claims, key.privateKey, 'k1');
  const res = await w.app.handleExchange(
    { proof: token, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'bad_proof' });
  assert.equal(res.acao, SERVICE_ORIGIN);
  assert.equal(
    stateRecord(w.appStore.get(`state:${r.start.stateId}`)).verifiedSub,
    null,
    'a rejected proof must not bind an identity'
  );
});

void test('the exchange window runs from proof issuance: a slow code step does not shut out a resend', async () => {
  const w = await makeWorld();
  // The person takes 61 seconds to read the mail and type the code.
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  const code = w.mailer.lastCode();
  w.advance(61_000);
  const verified = await readVerified(
    await browser.verify({
      challengeId: created.challengeId,
      code,
      address: OWNER
    })
  );
  assert.ok(verified.proof, 'proof issued after a slow code step');
  const exchange = await w.app.handleExchange(
    { proof: verified.proof, state: verified.state },
    SERVICE_ORIGIN
  );
  assert.equal(
    exchange.status,
    200,
    'window runs from issuance, not state creation'
  );
});

void test('the exchange rejects a proof 61 seconds after issuance', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w, { redeem: false });
  w.advance(61_000);
  const late = await w.app.handleExchange(
    { proof: r.verified.proof, state: r.verified.state },
    SERVICE_ORIGIN
  );
  assert.notEqual(
    late.status,
    200,
    'an exchange 61 seconds after issuance is rejected'
  );
});

void test('exchange window boundary: 59,999 ms after issuance succeeds; 60,000 and 60,001 reject', async () => {
  /** @type {[number, boolean][]} */
  const windows = [
    [59_999, true],
    [60_000, false],
    [60_001, false]
  ];
  for (const [ms, ok] of windows) {
    const w = await makeWorld();
    const r = await honestSignIn(w, { redeem: false });
    assert.ok(r.verified.proof, 'setup proof');
    w.advance(ms);
    const res = await w.app.handleExchange(
      { proof: r.verified.proof, state: r.verified.state },
      SERVICE_ORIGIN
    );
    assert.equal(res.status === 200, ok, `exchange at +${String(ms)} ms`);
  }
});

void test('a proof whose header or signed payload cannot be read is rejected before any claim is trusted [R4]', async () => {
  const { publicKey, privateKey } = await generateSigningKeyPair();
  const enc = new TextEncoder();
  const [header, payload, signature] = (
    await signProof({ sub: 'x' }, privateKey, 'k1')
  ).split('.');
  await assert.rejects(
    () =>
      verifyProofSignature(
        `${toBase64Url(enc.encode('not json'))}.${payload}.${signature}`,
        publicKey
      ),
    /malformed proof header/
  );
  // A correctly signed payload that is not JSON is still refused.
  const badPayload = toBase64Url(enc.encode('not json'));
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      enc.encode(`${header}.${badPayload}`)
    )
  );
  await assert.rejects(
    () =>
      verifyProofSignature(
        `${header}.${badPayload}.${toBase64Url(sig)}`,
        publicKey
      ),
    /malformed proof payload/
  );
});

void test('a proof whose signature does not verify is rejected as a bad signature [R4]', async () => {
  const { publicKey, privateKey } = await generateSigningKeyPair();
  const [header, payload, signature] = (
    await signProof({ sub: 'x' }, privateKey, 'k1')
  ).split('.');
  // One changed character, still valid base64url: decodes fine, verifies false.
  const forged = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  await assert.rejects(
    () => verifyProofSignature(`${header}.${payload}.${forged}`, publicKey),
    /bad signature/
  );
});

void test('a proof without exactly three parts, or naming another algorithm, is rejected before verification [R4]', async () => {
  const { publicKey } = await generateSigningKeyPair();
  const enc = new TextEncoder();
  await assert.rejects(
    () =>
      verifyProofSignature(
        `${toBase64Url(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: 'k1' })))}.e30`,
        publicKey
      ),
    /malformed proof/
  );
  // The pinned algorithm decides, never the token - even when the
  // header names a known key.
  const confused = toBase64Url(
    enc.encode(JSON.stringify({ alg: 'HS256', kid: 'k1', typ: 'JWT' }))
  );
  await assert.rejects(
    () => verifyProofSignature(`${confused}.e30.c2ln`, publicKey),
    /unexpected algorithm/
  );
});

void test('timingSafeEqual refuses different-length inputs instead of comparing them', () => {
  assert.equal(
    timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])),
    false
  );
  assert.equal(timingSafeEqual(new Uint8Array([]), new Uint8Array([1])), false);
  assert.equal(
    timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])),
    true
  );
});

void test('a JSON-null proof header rejects at the first member read [R4]', async () => {
  const { publicKey } = await generateSigningKeyPair();
  const header = toBase64Url(new TextEncoder().encode('null'));
  await assert.rejects(
    () => verifyProofSignature(`${header}.e30.c2ln`, publicKey),
    TypeError
  );
});

void test('a primitive proof header has no accepted algorithm [R4]', async () => {
  const { publicKey } = await generateSigningKeyPair();
  const header = toBase64Url(new TextEncoder().encode('5'));
  await assert.rejects(
    () => verifyProofSignature(`${header}.e30.c2ln`, publicKey),
    /unexpected algorithm/
  );
});
