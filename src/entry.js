// Worker entry for the production service (PR-3 wiring). The service
// runs INSIDE the Durable Object: the store contract requires
// synchronous access to the object's SQLite storage, which only exists
// in the object's own context. The worker itself only forwards to the
// one named object, so all state for the owner-only trial lives in a
// single SQLite-backed Durable Object (requirements: Atomicity).
//
// Config arrives through env: secrets hold values, never the repo (R10).
//   RESEND_API_KEY  (secret) Resend API key; exists only in the adapter.
//   MAIL_FROM       (secret) no-reply sender on the sending subdomain
//                            (E12 plan; delivery-tested November 1);
//                            a secret because R10 keeps addresses out
//                            of the repo.
//   CODE_HMAC_KEY   (secret) base64url bytes for the code HMAC.
//   STATE_HMAC_KEY  (secret) base64url bytes for the state HMAC.
//   SIGNING_KEYS    (secret) JSON { currentKid, keys: [{ kid, publicJwk,
//                            privateJwk, status, notAfterMs }] }.
//   EPOCH           (secret) JSON { value: <number> }; the owner raises
//                            it after a restore (R14/R15).
//   ALLOWLIST       (secret) JSON array of exact owner addresses.
//   APPS            (secret) JSON [{ origin, callbackUrl }], exact only.
//   SERVICE_ORIGIN  (var)    e.g. https://salutant.soliskit.com.

import { SalutantService } from './service.js';
import { SalutantStoreDO as StoreDO } from './do-store.js';
import { ResendMailAdapter } from './mail-resend.js';
import { createWorker } from './worker.js';
import { fromBase64Url, recordOf } from './crypto.js';

// Exported for the signing-key boundary regression (tests/signing-key-jwk.test.js).
/** @param {string} text */
export async function importSigningKeys(text) {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  const { currentKid, keys } = recordOf(parsed);
  /** @type {Map<unknown, import('./service.js').SigningKey>} */
  const signingKeys = new Map();
  for (const item of iterableJson(keys)) {
    const k = recordOf(item);
    const [publicKey, privateKey] = await Promise.all([
      crypto.subtle.importKey(
        'jwk',
        checkedImportJwk(k.publicJwk),
        { name: 'Ed25519' },
        true,
        ['verify']
      ),
      crypto.subtle.importKey(
        'jwk',
        checkedImportJwk(k.privateJwk),
        { name: 'Ed25519' },
        true,
        ['sign']
      )
    ]);
    signingKeys.set(k.kid, {
      publicKey,
      privateKey,
      status: k.status,
      notAfterMs: k.notAfterMs
    });
  }
  return { signingKeys, currentKid };
}

/**
 * @typedef {{ SIGNING_KEYS: string, EPOCH: string, RESEND_API_KEY: string,
 * MAIL_FROM: string, ALLOWLIST: string, APPS: string, SERVICE_ORIGIN: string,
 * CODE_HMAC_KEY: string, STATE_HMAC_KEY: string }} ServiceBindings
 */
/** @param {import('./do-store.js').DurableObjectStore} store @param {ServiceBindings} env */
async function buildService(store, env) {
  const { signingKeys, currentKid } = await importSigningKeys(env.SIGNING_KEYS);
  /** @type {unknown} */
  const epoch = JSON.parse(env.EPOCH);
  const service = new SalutantService({
    store,
    mailer: new ResendMailAdapter({
      apiKey: env.RESEND_API_KEY,
      from: env.MAIL_FROM
    }),
    epochSource: {
      /** @returns {Promise<unknown>} */
      read() {
        return new Promise((resolve) => {
          resolve(recordOf(epoch).value);
        });
      }
    },
    allowlist: iterableOrNull(parseBinding(env.ALLOWLIST)),
    apps: parseBinding(env.APPS),
    serviceOrigin: env.SERVICE_ORIGIN,
    codeHmacKeyBytes: fromBase64Url(env.CODE_HMAC_KEY),
    stateHmacKeyBytes: fromBase64Url(env.STATE_HMAC_KEY),
    signingKeys,
    currentKid
  });
  await service.ready();
  return service;
}

// Durable Object class bound in wrangler.jsonc. Builds the service once
// per object instance and reuses it; each request runs through the same
// createWorker routing the local tests use, and the hourly alarm runs the
// purge on the same single build. The alarm is the platform's private
// scheduled invocation: no request route exposes the purge (issue #106).
const PURGE_INTERVAL_MS = 3_600_000;

/**
 * @typedef {import('./do-store.js').DurableStorageLike & {
 *   getAlarm(): number | null | Promise<number | null>,
 *   setAlarm(time: number): void | Promise<void>
 * }} AlarmStorage
 * @typedef {{ storage: AlarmStorage,
 *   blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
 * }} ServiceContext
 */
/** @extends {StoreDO<ServiceBindings>} */
export class SalutantStoreDO extends StoreDO {
  /**
   * @param {ServiceContext} ctx
   * @param {ServiceBindings} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    /** @type {Promise<SalutantService> | null} */
    this.servicePromise = null;
    /** @type {Promise<ReturnType<typeof createWorker>> | null} */
    this.workerPromise = null;
    // Schedule the hourly purge once per stored object. The alarm lives
    // in the object's own storage; the getAlarm check keeps a wake from
    // overriding the alarm that is about to run (platform guidance).
    void ctx.blockConcurrencyWhile(async () => {
      if (!(await ctx.storage.getAlarm())) {
        await ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS);
      }
    });
  }

  service() {
    if (!this.servicePromise) {
      this.servicePromise = buildService(this.store, this.env);
    }
    return this.servicePromise;
  }

  /** @param {Request} request */
  async fetch(request) {
    if (!this.workerPromise) {
      this.workerPromise = this.service().then((service) =>
        createWorker(service)
      );
    }
    const worker = await this.workerPromise;
    return worker.fetch(request);
  }

  // Hourly housekeeping (issue #106): deletes every record past its
  // retention. Rescheduling happens even when the purge fails, so the
  // next successful run can purge eligible records; repeated failures
  // can delay cleanup.
  async alarm() {
    try {
      const service = await this.service();
      service.purge();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS);
    }
  }
}

/**
 * @typedef {{ SALUTANT_STORE: {
 *   idFromName(name: string): unknown,
 *   get(id: unknown): { fetch(request: Request): Promise<Response> }
 * } }} WorkerBindings
 */
export default {
  /** @param {Request} request @param {WorkerBindings} env */
  async fetch(request, env) {
    const stub = env.SALUTANT_STORE.get(
      env.SALUTANT_STORE.idFromName('service')
    );
    return stub.fetch(request);
  }
};

/** @param {unknown} value @returns {Iterable<unknown>} */
function iterableJson(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const rows = /** @type {unknown[]} */ (value);
    return rows;
  }
  throw new TypeError('JSON value is not iterable');
}

/** @param {unknown} value @returns {JsonWebKey} */
function checkedImportJwk(value) {
  // Preserve the former spread, then WebIDL's dictionary member conversions.
  const fields = { ...(value === null ? {} : recordOf(value)) };
  /** @type {JsonWebKey} */
  const jwk = { alg: 'EdDSA' };
  for (const key of /** @type {const} */ ([
    'crv',
    'd',
    'dp',
    'dq',
    'e',
    'ext',
    'k',
    'key_ops',
    'kty',
    'n',
    'oth',
    'p',
    'q',
    'qi',
    'use',
    'x',
    'y'
  ])) {
    const member = fields[key];
    if (member === undefined) continue;
    if (key === 'ext') jwk.ext = Boolean(member);
    else if (key === 'key_ops')
      jwk.key_ops = jsonSequence(member).map((op) => jwkString(op));
    else if (key === 'oth') jwk.oth = checkedOtherPrimes(member);
    else jwk[key] = jwkString(member);
  }
  return jwk;
}

/** @param {unknown} value @returns {unknown[]} */
function jsonSequence(value) {
  if (!Array.isArray(value))
    throw new TypeError('JSON sequence is not an array');
  return /** @type {unknown[]} */ (value);
}

/** @param {string} value @returns {unknown} */
function parseBinding(value) {
  return JSON.parse(value);
}
/** @param {unknown} value @returns {Iterable<unknown> | null} */
function iterableOrNull(value) {
  if (value === null) return null;
  return lazyJsonIterable(value);
}

/** @param {unknown} value @returns {RsaOtherPrimesInfo[]} */
function checkedOtherPrimes(value) {
  return jsonSequence(value).map((row) => {
    if (row !== null && typeof row !== 'object')
      throw new TypeError('JWK other-prime member is not a dictionary');
    const fields = row === null ? {} : recordOf(row);
    /** @type {RsaOtherPrimesInfo} */
    const item = {};
    for (const key of /** @type {const} */ (['d', 'r', 't'])) {
      const member = fields[key];
      if (member !== undefined) item[key] = jwkString(member);
    }
    return item;
  });
}

/** @param {unknown} value @returns {IterableIterator<unknown>} */
function* lazyJsonIterable(value) {
  yield* iterableJson(value);
}

/** @param {unknown} value @returns {string} */
function jwkString(value) {
  if (value !== null && typeof value === 'object')
    throw new TypeError('JWK string member must be a JSON scalar');
  return String(value);
}
