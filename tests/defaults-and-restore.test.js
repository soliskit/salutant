// Non-security gap tests: the storage snapshot constructor branch and
// the default wall-clock fallbacks used when no clock is injected.
// These tests never touch authentication, cookies, replay protection
// or cryptography behavior; they only exercise construction defaults
// and plain storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/storage.js';
import { SalutantService } from '../src/service.js';
import { StubApp } from '../src/stub-app.js';
import { MockMailAdapter } from '../src/mail-mock.js';
import { generateSigningKeyPair } from '../src/crypto.js';
import { SERVICE_ORIGIN, APP_ORIGIN, OWNER } from './helpers.js';

test('MemoryStore can be constructed from a snapshot', () => {
  const a = new MemoryStore();
  a.set('k', { n: 1 });
  const b = new MemoryStore(a.snapshot());
  assert.deepEqual(b.get('k'), { n: 1 });
});

test('SalutantService uses the wall clock when no clock is injected', async () => {
  const keyPair = await generateSigningKeyPair();
  const signingKeys = new Map([['k1', { ...keyPair, status: 'current', notAfterMs: null }]]);
  const logSink = [];
  const service = new SalutantService({
    store: new MemoryStore(),
    mailer: new MockMailAdapter({ behavior: 'accepted' }),
    epochSource: { async read() { return 1; } },
    allowlist: [OWNER],
    apps: [{ origin: APP_ORIGIN, callbackUrl: `${APP_ORIGIN}/auth/callback` }],
    serviceOrigin: SERVICE_ORIGIN,
    codeHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    stateHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    signingKeys, currentKid: 'k1', logSink,
  });
  await service.ready();
  const before = Date.now();
  service.log('probe', 'ok', 'test');
  const after = Date.now();
  const t = Date.parse(logSink[0].time);
  assert.ok(t >= before - 1000 && t <= after + 1000, `log time ${logSink[0].time} not near wall clock`);
});

test('StubApp uses the wall clock when no clock is injected', async () => {
  const appStore = new MemoryStore();
  const app = new StubApp({
    origin: APP_ORIGIN,
    serviceOrigin: SERVICE_ORIGIN,
    fetchJwks: async () => { throw new Error('not needed for this test'); },
    store: appStore,
    stateHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
  });
  await app.ready();
  const before = Date.now();
  const start = await app.startSignIn(null);
  const after = Date.now();
  const pending = appStore.get(`state:${start.stateId}`);
  assert.ok(pending, 'pending state stored');
  assert.ok(pending.createdAtMs >= before && pending.createdAtMs <= after,
    `createdAtMs ${pending.createdAtMs} not between ${before} and ${after}`);
});
