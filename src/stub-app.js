// Stub app. Stands in for a
// connected app: it registers an exact origin and callback, starts
// sign-ins, redeems proofs against its own store, and owns sessions and
// the replay record. Salutant never sees sessions; this app never sees
// challenges. No real app is touched.

import {
  randomId,
  importHmacKey,
  hmacSha256,
  verifyProofSignature,
  recordOf,
  toBase64Url,
  fromBase64Url,
  timingSafeEqual
} from './crypto.js';
import { DEFAULT_CONFIG } from './service.js';

/**
 * @typedef {{ stateId: string, cookieHmac: string, createdAtMs: number,
 *   verifiedSub: string | null, consumed: boolean,
 *   verifiedEpoch?: number, verifiedAtMs?: number }} StubStateRecord
 * @typedef {{ jti: string, redeemedAtMs: number,
 *   sessionId: string | null }} StubRedemptionRecord
 * @typedef {{ sessionId: string, sub: string, epoch: number,
 *   createdAtMs: number }} StubSessionRecord
 * @typedef {{ fetchedAtMs: number, keys: Map<unknown, CryptoKey>,
 *   epoch: number }} StubJwksCache
 * @typedef {{ pageUrl: string, stateId: string, cookieValue: string,
 *   setCookie: string | null }} StubStartResult
 * @typedef {{ status: number, acao: string | null,
 *   body: { error: string } | { completeUrl: string } }} StubExchangeResult
 * @typedef {{ status: 401, body: { error: string } }
 *   | { status: 200, body: { sessionId: string, sub: unknown },
 *       setCookie: string }} StubCompleteResult
 * @typedef {{ iss: string, aud: string, sub: string, nonce: string,
 *   jti: string, exp: number, nbf: number, iat: number,
 *   epoch: number }} StubProofClaims
 */

export class StubApp {
  /**
   * @param {{ origin: string, callbackPath?: string, completePath?: string,
   *   serviceOrigin: string,
   *   fetchJwks: () => Promise<{ keys: (JsonWebKey & { kid: string })[], epoch: number }>,
   *   store: import('./storage.js').MemoryStore,
   *   stateHmacKeyBytes: BufferSource, clock?: () => number,
   *   config?: Partial<typeof DEFAULT_CONFIG> }} options
   */
  constructor({
    origin, // exact origin, e.g. https://app.example.test
    callbackPath = '/auth/callback',
    completePath = '/auth/complete',
    serviceOrigin, // expected issuer, e.g. https://salutant.example.test
    fetchJwks, // () => Promise<{ keys, epoch }> - one HTTP call to the service
    store, // MemoryStore for states, redemptions, sessions
    stateHmacKeyBytes, // app-side secret for hashing the pre-auth cookie
    clock = () => Date.now(),
    config = {}
  }) {
    this.origin = origin;
    this.callbackUrl = origin + callbackPath;
    this.completeUrl = origin + completePath;
    this.serviceOrigin = serviceOrigin;
    this.fetchJwks = fetchJwks;
    this.store = store;
    this.clock = clock;
    this.config = { ...DEFAULT_CONFIG, ...config };
    /** @type {StubJwksCache | null} */
    this.jwksCache = null; // { fetchedAtMs, keys: Map kid -> CryptoKey, epoch }
    this._keyReady = importHmacKey(stateHmacKeyBytes).then((k) => {
      this._stateKey = k;
      return undefined;
    });
  }

  async ready() {
    await this._keyReady;
  }

  /** @param {string} message */
  async _hmac(message) {
    return toBase64Url(await hmacSha256(this._stateKey, message));
  }

  // Step 1: the person opens the app's sign-in page (top-level GET).
  // The app sets an anonymous pre-auth cookie (host-only, Secure,
  // HttpOnly, SameSite=Lax) and creates a server-side pending state
  // bound to that cookie value, then sends the person to the service's
  // code page. No token travels in the service URL beyond the state id.
  /**
   * @param {string | null | undefined} preAuthCookieValue
   * @returns {Promise<StubStartResult>}
   */
  async startSignIn(preAuthCookieValue) {
    const isNew = !preAuthCookieValue;
    const cookieValue = preAuthCookieValue ?? randomId(24);
    const cookieHmac = await this._hmac(`pre:${cookieValue}`);
    const stateId = randomId(24);
    this.store.transact((s) => {
      s.set(`state:${stateId}`, {
        stateId,
        cookieHmac,
        createdAtMs: this.clock(),
        verifiedSub: null,
        consumed: false
      });
    });
    return {
      pageUrl: `${this.serviceOrigin}/?app=${encodeURIComponent(this.origin)}&state=${encodeURIComponent(stateId)}`,
      stateId,
      cookieValue,
      setCookie: isNew
        ? `pre=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`
        : null
    };
  }

  // Key cache: at most [5 minutes], then refresh or fail closed (R12).
  async _jwks() {
    const now = this.clock();
    if (
      this.jwksCache &&
      now - this.jwksCache.fetchedAtMs < this.config.keyCacheMs
    ) {
      return this.jwksCache;
    }
    const fresh = await this.fetchJwks(); // a failure here fails closed
    /** @type {Map<unknown, CryptoKey>} */
    const keys = new Map();
    for (const jwk of fresh.keys) {
      keys.set(
        jwk.kid,
        await globalThis.crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'Ed25519' },
          false,
          ['verify']
        )
      );
    }
    this.jwksCache = { fetchedAtMs: now, keys, epoch: fresh.epoch };
    return this.jwksCache;
  }

  /** @param {unknown} kid */
  async _jwksWithOneRetry(kid) {
    let cache = await this._jwks();
    if (!cache.keys.has(kid)) {
      this.jwksCache = null; // unknown key id: one forced refresh, then reject
      cache = await this._jwks();
    }
    return cache;
  }

  // Step 2: bounded exchange. The code
  // page's script POSTs the proof here cross-origin. This endpoint
  // verifies everything and binds the verified address to the pending
  // state, but creates no session: a cross-site POST carries no
  // SameSite=Lax cookie, so the browser is not yet authenticated.
  //
  // corsOrigin: the request's Origin header, checked exactly.
  /**
   * @param {{ proof: string, state: string }} request
   * @param {string | null | undefined} corsOrigin
   * @returns {Promise<StubExchangeResult>}
   */
  async handleExchange({ proof, state }, corsOrigin) {
    if (corsOrigin !== this.serviceOrigin) {
      return { status: 403, acao: null, body: { error: 'bad_origin' } };
    }
    /** @type {unknown} */
    let claims;
    /** @type {StubProofClaims} */
    let verified;
    try {
      const parts = proof.split('.');
      /** @type {unknown} */
      const rawHeader = JSON.parse(
        new TextDecoder().decode(fromBase64Url(parts[0]))
      );
      // kid stays unknown: it is only used as a cache key, so a missing or
      // non-string kid is not found and ends as unknown_key, as before. A
      // null header throws here and ends as bad_proof.
      const kid = recordOf(rawHeader).kid;
      const cache = await this._jwksWithOneRetry(kid);
      const publicKey = cache.keys.get(kid);
      if (!publicKey)
        return {
          status: 400,
          acao: this.serviceOrigin,
          body: { error: 'unknown_key' }
        };
      ({ claims } = await verifyProofSignature(proof, publicKey));
      const now = this.clock();
      const skew = this.config.clockSkewMs;
      // Required claims must be present and typed: a signed proof that
      // omits exp, nbf, iat or jti is rejected, not waved through by
      // comparisons against undefined (R4).
      const { iss, aud, sub, nonce, jti, exp, nbf, iat, epoch } =
        recordOf(claims);
      const wellFormed =
        typeof iss === 'string' &&
        typeof aud === 'string' &&
        typeof sub === 'string' &&
        typeof nonce === 'string' &&
        typeof jti === 'string' &&
        jti.length > 0 &&
        typeof exp === 'number' &&
        typeof nbf === 'number' &&
        typeof iat === 'number' &&
        typeof epoch === 'number';
      if (!wellFormed)
        return {
          status: 400,
          acao: this.serviceOrigin,
          body: { error: 'bad_proof' }
        };
      // The typeof checks above establish string/number types only; they do
      // not prove finite, integer or in-range values.
      verified = { iss, aud, sub, nonce, jti, exp, nbf, iat, epoch };
      // The bounded exchange window runs from proof issuance, not from
      // state creation: a resend (60s cooldown) must still be able to
      // complete a sign-in.
      if (now - verified.iat * 1000 >= 60_000) {
        return {
          status: 400,
          acao: this.serviceOrigin,
          body: { error: 'bad_proof' }
        };
      }
      const bad =
        verified.iss !== this.serviceOrigin ||
        verified.aud !== this.origin ||
        verified.epoch !== cache.epoch ||
        verified.exp * 1000 < now - skew ||
        verified.nbf * 1000 > now + skew ||
        verified.iat * 1000 > now + skew ||
        verified.nonce !== state;
      if (bad)
        return {
          status: 400,
          acao: this.serviceOrigin,
          body: { error: 'bad_proof' }
        };
    } catch {
      return {
        status: 400,
        acao: this.serviceOrigin,
        body: { error: 'bad_proof' }
      };
    }

    // Replay protection and the state binding are one atomic step: the
    // proof id is checked against the redemption record and recorded,
    // and the pending state is marked verified, together.
    const verdict = this.store.transact((s) => {
      if (s.getRef(`redemption:${verified.jti}`)) return 'replayed';
      const pending = s.getRef(`state:${state}`);
      if (
        !pending ||
        storedFields(pending).consumed ||
        storedFields(pending).verifiedSub
      )
        return 'bad_state';
      s.set(`redemption:${verified.jti}`, {
        jti: verified.jti,
        redeemedAtMs: this.clock(),
        sessionId: null
      });
      writeStoredField(pending, 'verifiedSub', verified.sub);
      writeStoredField(pending, 'verifiedEpoch', verified.epoch);
      writeStoredField(pending, 'verifiedAtMs', this.clock()); // the completion window starts at verification
      return 'ok';
    });
    if (verdict !== 'ok') {
      return {
        status: 400,
        acao: this.serviceOrigin,
        body: { error: verdict }
      };
    }
    return {
      status: 200,
      acao: this.serviceOrigin,
      body: { completeUrl: this.completeUrl }
    };
  }

  // Step 3: top-level GET navigation. The SameSite=Lax pre-auth cookie
  // travels on this request, binding the browser to the pending state
  // the exchange verified. This is what stops login CSRF with
  // attacker-owned state: the attacker's verified state is bound to the
  // attacker's cookie, never the victim's.
  /**
   * Returns a plain object when no cookie is present, otherwise a Promise.
   * @param {string | null | undefined} cookieHeader
   * @returns {StubCompleteResult | Promise<StubCompleteResult>}
   */
  handleComplete(cookieHeader) {
    const pre = cookieHeader?.match(/(?:^|;\s*)pre=([^;]+)/)?.[1];
    if (!pre) return { status: 401, body: { error: 'no_session' } };
    return this._completeWithCookie(pre);
  }

  /**
   * @param {string} pre
   * @returns {Promise<StubCompleteResult>}
   */
  async _completeWithCookie(pre) {
    const cookieHmac = await this._hmac(`pre:${pre}`);
    const now = this.clock();
    return this.store.transact(
      /**
       * @param {import('./storage.js').MemoryStore} s
       * @returns {StubCompleteResult}
       */
      (s) => {
        const pending = s
          .keysWithPrefix('state:')
          .map((k) => s.getRef(k))
          .find(
            (p) =>
              timingSafeEqual(
                fromBase64Url(storedCookieHmac(storedFields(p).cookieHmac)),
                fromBase64Url(cookieHmac)
              ) &&
              storedFields(p).verifiedSub &&
              !storedFields(p).consumed &&
              storedFields(p).verifiedAtMs &&
              now - Number(storedFields(p).verifiedAtMs) < 60_000
          ); // completion is bounded
        if (!pending)
          return { status: 401, body: { error: 'no_verified_signin' } };
        writeStoredField(pending, 'consumed', true); // one-time
        const sessionId = randomId(24);
        // Restored fields remain unknown. The predicate established truthiness,
        // not a string identity or numeric epoch.
        const verifiedSub = storedFields(pending).verifiedSub;
        const verifiedEpoch = storedFields(pending).verifiedEpoch;
        const session = {
          sessionId,
          sub: verifiedSub,
          epoch: verifiedEpoch,
          createdAtMs: now
        };
        s.set(`session:${sessionId}`, session);
        // The first redemption record not yet bound to a session. Records
        // are written under `redemption:${jti}` with the same jti, so this
        // is the record the original keyed lookup reached.
        const open = [...s.keysWithPrefix('redemption:')]
          .map((k) => s.getRef(k))
          .find((x) => storedFields(x).sessionId === null);
        if (open) writeStoredField(open, 'sessionId', sessionId);
        return {
          status: 200,
          body: { sessionId, sub: verifiedSub },
          setCookie: `sess=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax`
        };
      }
    );
  }

  // R12/R14: on epoch change or emergency revoke the app drops sessions
  // issued before the new epoch and its cached keys.
  /** @param {number} epoch */
  dropSessionsBefore(epoch) {
    this.store.transact((s) => {
      for (const k of s.keysWithPrefix('session:')) {
        if (Number(storedFields(s.getRef(k)).epoch) < epoch) s.delete(k);
      }
    });
    this.jwksCache = null;
  }

  /** @param {string} sessionId */
  sessionExists(sessionId) {
    return (
      this.store.transact((s) => s.get(`session:${sessionId}`)) !== undefined
    );
  }
}

// These readers cover ordinary restored JSON and internally written records.
// They do not validate a whole record or copy a stored object. Object() boxes
// primitives for reads and preserves object references and prototype reads.
/** @param {unknown} value */
function storedFields(value) {
  if (value === null || value === undefined)
    throw new TypeError('stored value has no members');
  /** @type {unknown} */
  const boxed = Object(value);
  return /** @type {Record<string, unknown>} */ (boxed);
}

// Check only at the original write point: an earlier read must not reject a
// truthy primitive before exchange has inserted its redemption record.
/**
 * @param {unknown} target
 * @param {string} key
 * @param {unknown} value
 */
function writeStoredField(target, key, value) {
  if (typeof target !== 'object')
    throw new TypeError('stored value cannot be written');
  const fields = /** @type {Record<string, unknown>} */ (target);
  fields[key] = value;
}

// The decoder uses string methods; ordinary non-string JSON already threw.
/** @param {unknown} value */
function storedCookieHmac(value) {
  if (typeof value !== 'string')
    throw new TypeError('stored cookie HMAC is not a string');
  return value;
}
