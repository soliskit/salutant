// Entry and Durable Object wiring: the worker forwards to the one named
// object, and the object builds the service once and serves it. Local
// only: a fake object namespace and the same in-memory SQLite storage
// shim the store tests use. Requests are static page assets, which are
// answered before any mail call, so nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import entry, { SalutantStoreDO } from '../src/entry.js';
import { generateSigningKeyPair, exportPublicJwk, exportSigningPrivateJwk, toBase64Url } from '../src/crypto.js';
import { makeDOStorage, SERVICE_ORIGIN, APP_ORIGIN, OWNER } from './helpers.js';

async function makeEnv() {
  const pair = await generateSigningKeyPair();
  const bytes = () => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  return {
    RESEND_API_KEY: 'test-key-not-real',
    MAIL_FROM: 'Salutant <no-reply@example.test>',
    CODE_HMAC_KEY: bytes(),
    STATE_HMAC_KEY: bytes(),
    SIGNING_KEYS: JSON.stringify({
      currentKid: 'k1',
      keys: [{
        kid: 'k1', status: 'current', notAfterMs: null,
        publicJwk: await exportPublicJwk(pair.publicKey, 'k1'),
        privateJwk: await exportSigningPrivateJwk(pair.privateKey),
      }],
    }),
    EPOCH: JSON.stringify({ value: 1 }),
    ALLOWLIST: JSON.stringify([OWNER]),
    APPS: JSON.stringify([{ origin: APP_ORIGIN, callbackUrl: `${APP_ORIGIN}/auth/callback` }]),
    SERVICE_ORIGIN,
  };
}

test('the worker forwards every request to the one named object', async () => {
  const names = [];
  const seen = [];
  const env = {
    SALUTANT_STORE: {
      idFromName(name) { names.push(name); return `id:${name}`; },
      get(id) {
        return { async fetch(request) { seen.push([id, request.url]); return new Response('from the object'); } };
      },
    },
  };
  const request = new Request(`${SERVICE_ORIGIN}/app.js`);
  const res = await entry.fetch(request, env);
  assert.equal(await res.text(), 'from the object');
  assert.deepEqual(names, ['service']);
  assert.deepEqual(seen, [['id:service', `${SERVICE_ORIGIN}/app.js`]]);
});

test('the object builds the service once and serves page assets through it', async () => {
  const object = new SalutantStoreDO({ storage: makeDOStorage() }, await makeEnv());
  assert.equal(object.workerPromise, null, 'nothing is built before the first request');
  const first = await object.fetch(new Request(`${SERVICE_ORIGIN}/app.js`));
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /^text\/javascript/);
  const built = object.workerPromise;
  assert.ok(built, 'the first request builds the service');
  const second = await object.fetch(new Request(`${SERVICE_ORIGIN}/style.css`));
  assert.equal(second.status, 200);
  assert.match(second.headers.get('content-type'), /^text\/css/);
  assert.equal(object.workerPromise, built, 'the second request reuses the same build');
});
