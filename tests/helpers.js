// Shared test harness. Builds a world: mock service + stub app with
// injected fakes and a controllable clock. Example addresses and origins
// only; nothing real is referenced.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/storage.js';
import { SalutantService } from '../src/service.js';
import { MockMailAdapter } from '../src/mail-mock.js';
import { StubApp } from '../src/stub-app.js';
import { createWorker } from '../src/worker.js';
import { generateSigningKeyPair } from '../src/crypto.js';

export const SERVICE_ORIGIN = 'https://salutant.example.test';
export const APP_ORIGIN = 'https://app.example.test';
export const OWNER = 'owner@example.test';
export const STRANGER = 'stranger@example.test';
export const ATTACKER = 'attacker@example.test';

// Durable Object sql.exec rows hold strings, numbers, null or ArrayBuffer.
// node:sqlite also reports bigint and Uint8Array; a Uint8Array is copied to an
// ArrayBuffer, and a bigint (never returned unless the engine is set to read
// big integers) fails loudly instead of being passed on.
/**
 * @param {import('node:sqlite').SQLOutputValue} cell
 * @returns {import('../src/do-store.js').SqlValue}
 */
function sqlValueOf(cell) {
  if (typeof cell === 'string' || typeof cell === 'number' || cell === null)
    return cell;
  if (cell instanceof Uint8Array) return cell.slice().buffer;
  throw new TypeError('unsupported SQL value');
}

/** @param {Record<string, import('node:sqlite').SQLOutputValue>} row */
function sqlRowOf(row) {
  /** @type {Record<string, import('../src/do-store.js').SqlValue>} */
  const out = {};
  for (const [name, cell] of Object.entries(row)) out[name] = sqlValueOf(cell);
  return out;
}

// Minimal Durable Object ctx.storage shape over a real SQLite engine:
// transactionSync(fn) and sql.exec(query, ...params) -> { toArray() }.
// Lets the whole service suite run against DurableObjectStore, the
// production storage twin, not only MemoryStore.
export function makeDOStorage() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    // Count of non-SELECT statements run, so tests can prove that a
    // read-only pass writes nothing. Reset it between phases; the
    // constructor's CREATE TABLE is a write too.
    writes: 0,
    // Scheduled alarm time in milliseconds, or null when none is set.
    alarmMs: /** @type {number | null} */ (null),
    /** @param {number} ms */
    setAlarm(ms) {
      storage.alarmMs = ms;
    },
    getAlarm() {
      return Promise.resolve(storage.alarmMs);
    },
    sql: {
      /** @param {string} query @param {import("node:sqlite").SQLInputValue[]} params */
      exec(query, ...params) {
        if (!/^\s*select/i.test(query)) storage.writes++;
        const stmt = db.prepare(query);
        if (/^\s*select/i.test(query)) {
          const rows = stmt.all(...params).map(sqlRowOf);
          return { toArray: () => rows };
        }
        stmt.run(...params);
        return { toArray: () => [] };
      }
    },
    /** @template T @param {() => T} fn @returns {T} */
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  };
  return storage;
}

export class ControllableEpoch {
  constructor(value = 1) {
    this.value = value;
    this.available = true;
  }
  read() {
    if (!this.available)
      return Promise.reject(new Error('epoch source unavailable'));
    return Promise.resolve(this.value);
  }
}

/**
 * @template {import('../src/service.js').ServiceStore} S
 * @typedef {object} WorldOptions
 * @property {number} [now]
 * @property {string[]} [allowlist]
 * @property {NonNullable<ConstructorParameters<typeof MockMailAdapter>[0]>['behavior']} [mailerBehavior]
 * @property {NonNullable<ConstructorParameters<typeof SalutantService>[0]>['config']} [config]
 * @property {NonNullable<ConstructorParameters<typeof StubApp>[0]>['config']} [appConfig]
 * @property {() => S} [storeFactory]
 */
/**
 * @template {import('../src/service.js').ServiceStore} S
 * @typedef {object} World
 * @property {SalutantService} service
 * @property {ReturnType<typeof createWorker>} worker
 * @property {StubApp} app
 * @property {S} store
 * @property {MemoryStore} appStore
 * @property {MockMailAdapter} mailer
 * @property {ControllableEpoch} epoch
 * @property {NonNullable<import('../src/service.js').ServiceOptions['logSink']>} logSink
 * @property {() => number} clock
 * @property {(ms: number) => void} advance
 * @property {(value: number) => void} setNow
 * @property {() => number} getNow
 */
/**
 * @overload
 * @param {Omit<WorldOptions<MemoryStore>, 'storeFactory'> & { storeFactory?: undefined }} [options]
 * @returns {Promise<World<MemoryStore>>}
 */
/**
 * @template {import('../src/service.js').ServiceStore} S
 * @overload
 * @param {WorldOptions<S> & { storeFactory: () => S }} options
 * @returns {Promise<World<S>>}
 */
/**
 * @overload
 * @param {WorldOptions<import('../src/service.js').ServiceStore>} [options]
 * @returns {Promise<World<import('../src/service.js').ServiceStore>>}
 */
/**
 * @param {WorldOptions<import('../src/service.js').ServiceStore>} [options]
 * @returns {Promise<World<import('../src/service.js').ServiceStore>>}
 */
export async function makeWorld({
  now = 1_759_600_000_000, // fixed start so windows are deterministic
  allowlist = [OWNER],
  mailerBehavior = 'accepted',
  config = {},
  appConfig = {},
  storeFactory = () => new MemoryStore()
} = {}) {
  let clockNow = now;
  const clock = () => clockNow;
  const store = storeFactory();
  const appStore = new MemoryStore();
  const mailer = new MockMailAdapter({ behavior: mailerBehavior });
  const epoch = new ControllableEpoch(1);
  const keyPair = await generateSigningKeyPair();
  const signingKeys = new Map([
    ['k1', { ...keyPair, status: 'current', notAfterMs: null }]
  ]);
  /** @type {NonNullable<import("../src/service.js").ServiceOptions["logSink"]>} */
  const logSink = [];
  const service = new SalutantService({
    store,
    mailer,
    epochSource: epoch,
    allowlist,
    apps: [{ origin: APP_ORIGIN, callbackUrl: `${APP_ORIGIN}/auth/callback` }],
    serviceOrigin: SERVICE_ORIGIN,
    codeHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    stateHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    signingKeys,
    currentKid: 'k1',
    clock,
    logSink,
    config
  });
  await service.ready();
  const worker = createWorker(service);
  const app = new StubApp({
    origin: APP_ORIGIN,
    serviceOrigin: SERVICE_ORIGIN,
    fetchJwks: async () => {
      const r = await service.fetch(
        new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`)
      );
      if (!r.ok) throw new Error('jwks unavailable');
      /** @type {unknown} */
      const body = await r.json();
      assert.ok(isJwksBody(body));
      return body;
    },
    store: appStore,
    stateHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    clock,
    config: appConfig
  });
  await app.ready();
  return {
    service,
    worker,
    app,
    store,
    appStore,
    mailer,
    epoch,
    logSink,
    clock,
    /** @param {number} ms */
    advance: (ms) => {
      clockNow += ms;
    },
    /** @param {number} v */
    setNow: (v) => {
      clockNow = v;
    },
    getNow: () => clockNow
  };
}

// A minimal browser: a cookie jar plus the fetch calls the page script
// would make. Never puts codes, proofs or addresses in URLs.
export class BrowserSession {
  /** @param {Awaited<ReturnType<typeof makeWorld>>} world */
  constructor(world) {
    this.world = world;
    /** @type {Map<string, { value: string, path: string }>} */
    this.cookies = new Map(); // name -> { value, path }
  }
  /** @param {string} path */
  _cookieHeaderFor(path) {
    return (
      [...this.cookies.entries()]
        .filter(([, c]) => path.startsWith(c.path))
        .map(([n, c]) => `${n}=${c.value}`)
        .join('; ') || null
    );
  }
  /** @param {Response} response */
  _storeCookies(response) {
    const setC = response.headers.getSetCookie();
    for (const line of setC) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const [name, value] = pair.split('=');
      const path =
        attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      this.cookies.set(name, { value, path });
    }
  }
  /**
   * @param {object} options
   * @param {string | number} options.address
   * @param {string} [options.appOrigin]
   * @param {string} options.stateId
   * @param {string | null} [options.idempotencyKey]
   * @param {Record<string, string>} [options.headers]
   */
  async postChallenge({
    address,
    appOrigin = APP_ORIGIN,
    stateId,
    idempotencyKey = null,
    headers = {}
  }) {
    const res = await this.world.worker.fetch(
      new Request(`${SERVICE_ORIGIN}/v1/challenges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...headers
        },
        body: JSON.stringify({ address, appOrigin, stateId })
      })
    );
    this._storeCookies(res);
    return res;
  }
  /**
   * @param {object} options
   * @param {string} options.challengeId
   * @param {string | number} options.address
   * @param {string | null} [options.idempotencyKey]
   */
  async resend({ challengeId, address, idempotencyKey = null }) {
    const res = await this.world.worker.fetch(
      new Request(`${SERVICE_ORIGIN}/v1/challenges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
        },
        body: JSON.stringify({ resendOf: challengeId, address })
      })
    );
    this._storeCookies(res);
    return res;
  }
  /** @param {{challengeId: string, code: string | number | null | undefined, address: string | number, omitCookies?: boolean}} options */
  async verify({ challengeId, code, address, omitCookies = false }) {
    const path = `/v1/challenges/${encodeURIComponent(challengeId)}/verify`;
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' };
    if (!omitCookies) {
      const c = this._cookieHeaderFor(path);
      if (c) headers.cookie = c;
    }
    return this.world.worker.fetch(
      new Request(`${SERVICE_ORIGIN}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code, address })
      })
    );
  }
  async getPage(appOrigin = APP_ORIGIN, stateId = 'x'.repeat(24)) {
    return this.world.worker.fetch(
      new Request(
        `${SERVICE_ORIGIN}/?app=${encodeURIComponent(appOrigin)}&state=${encodeURIComponent(stateId)}`
      )
    );
  }
}

/** @typedef {Awaited<ReturnType<StubApp['handleComplete']>>} CompleteResult */
/** @typedef {{ challengeId: string, [field: string]: unknown }} CreatedBody */
/** @typedef {{ proof: string, state: string, [field: string]: unknown }} VerifiedBody */
/**
 * @typedef {object} HonestSignInResult
 * @property {Awaited<ReturnType<StubApp['startSignIn']>>} start
 * @property {Response} page
 * @property {Response} create
 * @property {CreatedBody} created
 * @property {ReturnType<MockMailAdapter['lastCode']>} code
 * @property {Response} verify
 * @property {VerifiedBody} verified
 * @property {Awaited<ReturnType<StubApp['handleExchange']>> | null} exchange
 * @property {CompleteResult | null} complete
 * @property {BrowserSession} browser
 */

/**
 * @param {unknown} body
 * @returns {body is CreatedBody}
 */
function isCreatedBody(body) {
  return (
    typeof body === 'object' &&
    body !== null &&
    'challengeId' in body &&
    typeof body.challengeId === 'string'
  );
}

/**
 * @param {unknown} body
 * @returns {body is VerifiedBody}
 */
function isVerifiedBody(body) {
  return (
    typeof body === 'object' &&
    body !== null &&
    'proof' in body &&
    typeof body.proof === 'string' &&
    'state' in body &&
    typeof body.state === 'string'
  );
}

/**
 * Reads a body expected to carry a string challengeId. Returns the same
 * parsed object, extras kept. Invalid JSON still fails in json().
 * @param {Response} response
 * @returns {Promise<CreatedBody>}
 */
export async function readCreated(response) {
  /** @type {unknown} */
  const body = await response.json();
  if (!isCreatedBody(body)) {
    throw new TypeError('challenge response has no string challengeId');
  }
  return body;
}

/**
 * Reads a body expected to carry string proof and state.
 * @param {Response} response
 * @returns {Promise<VerifiedBody>}
 */
export async function readVerified(response) {
  /** @type {unknown} */
  const body = await response.json();
  if (!isVerifiedBody(body)) {
    throw new TypeError('verify response has no string proof and state');
  }
  return body;
}

// Drive a whole sign-in the honest way. Returns every artifact.
/** @param {Awaited<ReturnType<typeof makeWorld>>} world @returns {Promise<HonestSignInResult>} */
export async function honestSignIn(
  world,
  { address = OWNER, browser = new BrowserSession(world), redeem = true } = {}
) {
  const start = await world.app.startSignIn(null);
  const page = await browser.getPage(APP_ORIGIN, start.stateId);
  const create = await browser.postChallenge({
    address,
    stateId: start.stateId
  });
  /** @type {unknown} */
  const created = await create.json();
  if (!isCreatedBody(created)) {
    throw new TypeError('challenge response has no string challengeId');
  }
  await world.service.drain();
  const code = world.mailer.lastCode();
  const verify = await browser.verify({
    challengeId: created.challengeId,
    code,
    address
  });
  /** @type {unknown} */
  const verified = await verify.json();
  if (!isVerifiedBody(verified)) {
    throw new TypeError('verify response has no string proof and state');
  }
  let exchange = null;
  let complete = null;
  if (verified.proof && redeem) {
    exchange = await world.app.handleExchange(
      { proof: verified.proof, state: verified.state },
      SERVICE_ORIGIN
    );
    if (exchange.status === 200) {
      complete = await world.app.handleComplete(`pre=${start.cookieValue}`);
    }
  }
  return {
    start,
    page,
    create,
    created,
    code,
    verify,
    verified,
    exchange,
    complete,
    browser
  };
}

/** @param {Response} response */
export function bodyText(response) {
  return response.text();
}

// A parsed JSON object, failing here as an assertion when the value is a
// list or not an object at all.
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
/**
 * The body StubApp's fetchJwks must return: a key list whose keys carry
 * string ids plus the numeric epoch.
 * @param {unknown} body
 * @returns {body is { keys: (JsonWebKey & { kid: string })[]; epoch: number }}
 */
function isJwksBody(body) {
  return (
    isRecord(body) &&
    Array.isArray(body.keys) &&
    body.keys.every((key) => isRecord(key) && typeof key.kid === 'string') &&
    typeof body.epoch === 'number'
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The key ids in a key listing. A listing without a keys list, or a key
// without an id, fails here as an assertion on the list that is returned.
/** @param {unknown} listing */
export function keyIds(listing) {
  assert.ok(
    typeof listing === 'object' &&
      listing !== null &&
      'keys' in listing &&
      Array.isArray(listing.keys),
    'the key listing carries a keys list'
  );
  return listing.keys.map((key) => {
    /** @type {unknown} */
    const item = key;
    if (typeof item !== 'object' || item === null || !('kid' in item))
      return undefined;
    return item.kid;
  });
}
