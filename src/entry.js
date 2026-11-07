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
import { fromBase64Url, normalizeEd25519Jwk } from './crypto.js';

// Exported for the signing-key boundary regression (tests/signing-key-jwk.test.js).
export async function importSigningKeys(text) {
  const { currentKid, keys } = JSON.parse(text);
  const signingKeys = new Map();
  for (const k of keys) {
    const [publicKey, privateKey] = await Promise.all([
      crypto.subtle.importKey(
        'jwk',
        normalizeEd25519Jwk(k.publicJwk),
        { name: 'Ed25519' },
        true,
        ['verify']
      ),
      crypto.subtle.importKey(
        'jwk',
        normalizeEd25519Jwk(k.privateJwk),
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

async function buildService(store, env) {
  const { signingKeys, currentKid } = await importSigningKeys(env.SIGNING_KEYS);
  const epoch = JSON.parse(env.EPOCH);
  const service = new SalutantService({
    store,
    mailer: new ResendMailAdapter({
      apiKey: env.RESEND_API_KEY,
      from: env.MAIL_FROM
    }),
    epochSource: {
      async read() {
        return epoch.value;
      }
    },
    allowlist: JSON.parse(env.ALLOWLIST),
    apps: JSON.parse(env.APPS),
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
// createWorker routing the local tests use.
export class SalutantStoreDO extends StoreDO {
  constructor(ctx, env) {
    super(ctx, env);
    this.workerPromise = null;
  }

  async fetch(request) {
    if (!this.workerPromise) {
      this.workerPromise = buildService(this.store, this.env).then((service) =>
        createWorker(service)
      );
    }
    const worker = await this.workerPromise;
    return worker.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const stub = env.SALUTANT_STORE.get(
      env.SALUTANT_STORE.idFromName('service')
    );
    return stub.fetch(request);
  }
};
