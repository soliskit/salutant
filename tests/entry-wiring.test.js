// Entry and Durable Object wiring: the worker forwards to the one named
// object, and the object builds the service once and serves it. Local
// only: a fake object namespace and the same in-memory SQLite storage
// shim the store tests use. Requests are static page assets, which are
// answered before any mail call, so nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import entry, { SalutantStoreDO } from '../src/entry.js';
import { createWorker } from '../src/worker.js';
import {
  generateSigningKeyPair,
  exportPublicJwk,
  exportSigningPrivateJwk,
  toBase64Url
} from '../src/crypto.js';
import {
  makeDOStorage,
  keyIds,
  SERVICE_ORIGIN,
  APP_ORIGIN,
  OWNER
} from './helpers.js';

// Object context stand-in: storage plus the platform's construction-time
// gate, which the shim runs immediately.
function makeCtx() {
  return {
    storage: makeDOStorage(),
    /**
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async blockConcurrencyWhile(fn) {
      return await fn();
    }
  };
}

// A response header the test then reads as text. A missing header fails
// here as an assertion, where a null read failed later.
/**
 * @param {Response} response
 * @param {string} name
 */
function headerOf(response, name) {
  const value = response.headers.get(name);
  assert.ok(value !== null, `the response has a ${name} header`);
  return value;
}

// The scheduled alarm time. No alarm fails here as an assertion.
/** @param {ReturnType<typeof makeCtx>} ctx */
async function alarmOf(ctx) {
  const alarm = await ctx.storage.getAlarm();
  assert.ok(alarm !== null, 'an alarm is scheduled');
  return alarm;
}

// A worker over a registry of apps. The page route answers before any
// call to the service, so a forwarded request fails the test.
/** @param {{ origin: string }[]} apps */
function pageOnlyWorker(apps) {
  return createWorker({
    apps,
    fetch() {
      assert.fail('the code-entry page does not reach the service');
    }
  });
}

async function makeEnv() {
  const pair = await generateSigningKeyPair();
  const bytes = () =>
    toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  return {
    RESEND_API_KEY: 'test-key-not-real',
    MAIL_FROM: 'Salutant <no-reply@example.test>',
    CODE_HMAC_KEY: bytes(),
    STATE_HMAC_KEY: bytes(),
    SIGNING_KEYS: JSON.stringify({
      currentKid: 'k1',
      keys: [
        {
          kid: 'k1',
          status: 'current',
          notAfterMs: null,
          publicJwk: await exportPublicJwk(pair.publicKey, 'k1'),
          privateJwk: await exportSigningPrivateJwk(pair.privateKey)
        }
      ]
    }),
    EPOCH: JSON.stringify({ value: 1 }),
    ALLOWLIST: JSON.stringify([OWNER]),
    APPS: JSON.stringify([
      { origin: APP_ORIGIN, callbackUrl: `${APP_ORIGIN}/auth/callback` }
    ]),
    SERVICE_ORIGIN
  };
}

void test('the worker forwards every request to the one named object', async () => {
  /** @type {string[]} */
  const names = [];
  /** @type {[unknown, string][]} */
  const seen = [];
  const env = {
    SALUTANT_STORE: {
      /** @param {string} name */
      idFromName(name) {
        names.push(name);
        return `id:${name}`;
      },
      /** @param {unknown} id */
      get(id) {
        return {
          /** @param {Request} request */
          fetch(request) {
            seen.push([id, request.url]);
            return Promise.resolve(new Response('from the object'));
          }
        };
      }
    }
  };
  const request = new Request(`${SERVICE_ORIGIN}/app.js`);
  const res = await entry.fetch(request, env);
  assert.equal(await res.text(), 'from the object');
  assert.deepEqual(names, ['service']);
  assert.deepEqual(seen, [['id:service', `${SERVICE_ORIGIN}/app.js`]]);
});

void test('the object builds the service once and serves page assets through it', async () => {
  const object = new SalutantStoreDO(makeCtx(), await makeEnv());
  assert.equal(
    object.workerPromise,
    null,
    'nothing is built before the first request'
  );
  const first = await object.fetch(new Request(`${SERVICE_ORIGIN}/app.js`));
  assert.equal(first.status, 200);
  assert.match(headerOf(first, 'content-type'), /^text\/javascript/);
  const built = object.workerPromise;
  assert.ok(built, 'the first request builds the service');
  const second = await object.fetch(new Request(`${SERVICE_ORIGIN}/style.css`));
  assert.equal(second.status, 200);
  assert.match(headerOf(second, 'content-type'), /^text\/css/);
  assert.equal(
    object.workerPromise,
    built,
    'the second request reuses the same build'
  );
});

// Exercises the production wiring's epochSource.read through the existing
// public-key route, without a challenge, mail call or production service.
void test('the object key endpoint returns the epoch from its configured environment', async () => {
  const env = await makeEnv();
  env.EPOCH = JSON.stringify({ value: 7 });
  const object = new SalutantStoreDO(makeCtx(), env);
  const response = await object.fetch(
    new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`)
  );
  assert.equal(response.status, 200);
  assert.match(headerOf(response, 'content-type'), /^application\/json/);
  /** @type {unknown} */
  const body = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'epoch' in body);
  assert.equal(
    body.epoch,
    7,
    'the endpoint reads the configured epoch, not a fixed default'
  );
  assert.deepEqual(keyIds(body), ['k1']);
});

// Checks the worker fallback for a normal registry containing a non-empty
// app origin. It makes no policy claim about configuring an empty origin.
void test('the code-entry page rejects a missing app parameter for a registered non-empty origin', async () => {
  const worker = pageOnlyWorker([{ origin: APP_ORIGIN }]);
  const response = await worker.fetch(new Request(`${SERVICE_ORIGIN}/`));
  assert.equal(response.status, 400);
  assert.match(headerOf(response, 'content-type'), /^text\/html/);
  const directives = headerOf(response, 'content-security-policy')
    .split(';')
    .map((part) => part.trim());
  assert.ok(directives.includes("connect-src 'self'"));
  assert.ok(directives.includes("form-action 'none'"));
  assert.ok(
    !headerOf(response, 'content-security-policy').includes(APP_ORIGIN)
  );
});

// R16 / exact origin list: with several registered apps, the page is served
// for each registered origin and still refused for an unregistered one.
void test('the code-entry page is served for each registered app origin and refused for an unregistered one', async () => {
  const second = 'https://second.example.test';
  const worker = pageOnlyWorker([{ origin: APP_ORIGIN }, { origin: second }]);
  for (const origin of [APP_ORIGIN, second]) {
    const response = await worker.fetch(
      new Request(`${SERVICE_ORIGIN}/?app=${encodeURIComponent(origin)}`)
    );
    assert.equal(response.status, 200, `${origin} is registered`);
    const directives = headerOf(response, 'content-security-policy')
      .split(';')
      .map((part) => part.trim());
    assert.ok(
      directives.includes(`connect-src 'self' ${origin}`),
      'connect-src names that exact origin'
    );
  }
  const refused = await worker.fetch(
    new Request(
      `${SERVICE_ORIGIN}/?app=${encodeURIComponent('https://other.example.test')}`
    )
  );
  assert.equal(refused.status, 400);
});

// Issue #106 regression: construction schedules the hourly purge alarm
// once per stored object, and a later wake does not override it.
void test('construction schedules the hourly alarm once', async () => {
  const ctx = makeCtx();
  new SalutantStoreDO(ctx, await makeEnv());
  await new Promise((resolve) => setImmediate(resolve));
  const first = await alarmOf(ctx);
  assert.ok(first > Date.now(), 'the first alarm is in the future');
  new SalutantStoreDO(ctx, await makeEnv());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await alarmOf(ctx),
    first,
    'a wake keeps the already scheduled alarm'
  );
});

// Issue #106 behavior: the alarm deletes a record already past its
// retention and reschedules itself; the same service build keeps
// serving requests afterwards.
void test('the alarm purges a record past its retention and reschedules', async () => {
  const ctx = makeCtx();
  const object = new SalutantStoreDO(ctx, await makeEnv());
  ctx.storage.sql.exec(
    "INSERT INTO records (key, value) VALUES ('challenge:seed', ?)",
    JSON.stringify({ expiresAtMs: Date.now() - 2 * 3_600_000 })
  );
  await object.alarm();
  const remaining = ctx.storage.sql
    .exec("SELECT value FROM records WHERE key = 'challenge:seed'")
    .toArray();
  assert.deepEqual(remaining, [], 'the expired record is purged');
  assert.ok(
    (await alarmOf(ctx)) > Date.now(),
    'the next hourly alarm is scheduled'
  );
  const page = await object.fetch(new Request(`${SERVICE_ORIGIN}/app.js`));
  assert.equal(page.status, 200, 'the same build keeps serving');
});

// Issue #106 resilience: a failing purge still reschedules, so the next
// successful run can purge eligible records.
void test('a failing purge still reschedules the alarm', async () => {
  const ctx = makeCtx();
  const object = new SalutantStoreDO(ctx, await makeEnv());
  ctx.storage.sql.exec(
    "INSERT INTO records (key, value) VALUES ('challenge:bad', 'not json')"
  );
  await assert.rejects(object.alarm(), SyntaxError);
  assert.ok(
    (await alarmOf(ctx)) > Date.now(),
    'the alarm is rescheduled despite the failure'
  );
});
