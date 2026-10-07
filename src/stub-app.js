// Stub app (contract: Records and app test harness). Stands in for a
// connected app: it registers an exact origin and callback, starts
// sign-ins, redeems proofs against its own store, and owns sessions and
// the replay record. Salutant never sees sessions; this app never sees
// challenges. No real app is touched.

import { randomId, importHmacKey, hmacSha256, verifyProofSignature, toBase64Url, fromBase64Url, timingSafeEqual } from './crypto.js';
import { DEFAULT_CONFIG } from './service.js';

export class StubApp {
  constructor({
    origin,              // exact origin, e.g. https://app.example.test
    callbackPath = '/auth/callback',
    completePath = '/auth/complete',
    serviceOrigin,       // expected issuer, e.g. https://salutant.example.test
    fetchJwks,           // () => Promise<{ keys, epoch }> - one HTTP call to the service
    store,               // MemoryStore for states, redemptions, sessions
    stateHmacKeyBytes,   // app-side secret for hashing the pre-auth cookie
    clock = () => Date.now(),
    config = {},
  }) {
    this.origin = origin;
    this.callbackUrl = origin + callbackPath;
    this.completeUrl = origin + completePath;
    this.serviceOrigin = serviceOrigin;
    this.fetchJwks = fetchJwks;
    this.store = store;
    this.clock = clock;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.jwksCache = null; // { fetchedAtMs, keys: Map kid -> CryptoKey, epoch }
    this._keyReady = importHmacKey(stateHmacKeyBytes).then((k) => { this._stateKey = k; });
  }

  async ready() { await this._keyReady; }

  async _hmac(message) { return toBase64Url(await hmacSha256(this._stateKey, message)); }

  // Step 1: the person opens the app's sign-in page (top-level GET).
  // The app sets an anonymous pre-auth cookie (host-only, Secure,
  // HttpOnly, SameSite=Lax) and creates a server-side pending state
  // bound to that cookie value, then sends the person to the service's
  // code page. No token travels in the service URL beyond the state id.
  async startSignIn(preAuthCookieValue) {
    const isNew = !preAuthCookieValue;
    const cookieValue = preAuthCookieValue ?? randomId(24);
    const cookieHmac = await this._hmac(`pre:${cookieValue}`);
    const stateId = randomId(24);
    this.store.transact((s) => {
      s.set(`state:${stateId}`, {
        stateId, cookieHmac, createdAtMs: this.clock(), verifiedSub: null, consumed: false,
      });
    });
    return {
      pageUrl: `${this.serviceOrigin}/?app=${encodeURIComponent(this.origin)}&state=${encodeURIComponent(stateId)}`,
      stateId,
      cookieValue,
      setCookie: isNew
        ? `pre=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`
        : null,
    };
  }

  // Key cache: at most [5 minutes], then refresh or fail closed (R12).
  async _jwks() {
    const now = this.clock();
    if (this.jwksCache && now - this.jwksCache.fetchedAtMs < this.config.keyCacheMs) {
      return this.jwksCache;
    }
    const fresh = await this.fetchJwks(); // a failure here fails closed
    const keys = new Map();
    for (const jwk of fresh.keys) {
      keys.set(jwk.kid, await globalThis.crypto.subtle.importKey(
        'jwk', jwk, { name: 'Ed25519' }, false, ['verify']));
    }
    this.jwksCache = { fetchedAtMs: now, keys, epoch: fresh.epoch };
    return this.jwksCache;
  }

  async _jwksWithOneRetry(kid) {
    let cache = await this._jwks();
    if (!cache.keys.has(kid)) {
      this.jwksCache = null; // unknown key id: one forced refresh, then reject
      cache = await this._jwks();
    }
    return cache;
  }

  // Step 2: bounded exchange (callback protocol, option 2). The code
  // page's script POSTs the proof here cross-origin. This endpoint
  // verifies everything and binds the verified address to the pending
  // state, but creates no session: a cross-site POST carries no
  // SameSite=Lax cookie, so the browser is not yet authenticated.
  //
  // corsOrigin: the request's Origin header, checked exactly.
  async handleExchange({ proof, state }, corsOrigin) {
    if (corsOrigin !== this.serviceOrigin) {
      return { status: 403, acao: null, body: { error: 'bad_origin' } };
    }
    let claims;
    try {
      const parts = proof.split('.');
      const header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
      const cache = await this._jwksWithOneRetry(header.kid);
      const publicKey = cache.keys.get(header.kid);
      if (!publicKey) return { status: 400, acao: this.serviceOrigin, body: { error: 'unknown_key' } };
      ({ claims } = await verifyProofSignature(proof, publicKey));
      const now = this.clock();
      const skew = this.config.clockSkewMs;
      const bad =
        claims.iss !== this.serviceOrigin ||
        claims.aud !== this.origin ||
        claims.epoch !== cache.epoch ||
        claims.exp * 1000 < now - skew ||
        claims.nbf * 1000 > now + skew ||
        claims.iat * 1000 > now + skew ||
        claims.nonce !== state;
      if (bad) return { status: 400, acao: this.serviceOrigin, body: { error: 'bad_proof' } };
    } catch {
      return { status: 400, acao: this.serviceOrigin, body: { error: 'bad_proof' } };
    }

    // Replay protection and the state binding are one atomic step: the
    // proof id is checked against the redemption record and recorded,
    // and the pending state is marked verified, together (contract:
    // Records and app test harness).
    const verdict = this.store.transact((s) => {
      if (s.getRef(`redemption:${claims.jti}`)) return 'replayed';
      const pending = s.getRef(`state:${state}`);
      if (!pending || pending.consumed || pending.verifiedSub) return 'bad_state';
      s.set(`redemption:${claims.jti}`, {
        jti: claims.jti, redeemedAtMs: this.clock(), sessionId: null,
      });
      pending.verifiedSub = claims.sub;
      pending.verifiedEpoch = claims.epoch;
      return 'ok';
    });
    if (verdict !== 'ok') {
      return { status: 400, acao: this.serviceOrigin, body: { error: verdict } };
    }
    return { status: 200, acao: this.serviceOrigin, body: { completeUrl: this.completeUrl } };
  }

  // Step 3: top-level GET navigation. The SameSite=Lax pre-auth cookie
  // travels on this request, binding the browser to the pending state
  // the exchange verified. This is what stops login CSRF with
  // attacker-owned state: the attacker's verified state is bound to the
  // attacker's cookie, never the victim's.
  handleComplete(cookieHeader) {
    const pre = cookieHeader?.match(/(?:^|;\s*)pre=([^;]+)/)?.[1];
    if (!pre) return { status: 401, body: { error: 'no_session' } };
    return this._completeWithCookie(pre);
  }

  async _completeWithCookie(pre) {
    const cookieHmac = await this._hmac(`pre:${pre}`);
    const now = this.clock();
    return this.store.transact((s) => {
      const pending = s.keysWithPrefix('state:')
        .map((k) => s.getRef(k))
        .find((p) => timingSafeEqual(fromBase64Url(p.cookieHmac), fromBase64Url(cookieHmac))
          && p.verifiedSub && !p.consumed
          && now - p.createdAtMs < 60_000); // the exchange is bounded
      if (!pending) return { status: 401, body: { error: 'no_verified_signin' } };
      pending.consumed = true; // one-time
      const sessionId = randomId(24);
      s.set(`session:${sessionId}`, {
        sessionId, sub: pending.verifiedSub, epoch: pending.verifiedEpoch, createdAtMs: now,
      });
      const r = s.getRef(`redemption:${[...s.keysWithPrefix('redemption:')]
        .map((k) => s.getRef(k)).find((x) => x.sessionId === null)?.jti}`);
      if (r) r.sessionId = sessionId;
      return {
        status: 200,
        body: { sessionId, sub: pending.verifiedSub },
        setCookie: `sess=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      };
    });
  }

  // R12/R14: on epoch change or emergency revoke the app drops sessions
  // issued before the new epoch and its cached keys.
  dropSessionsBefore(epoch) {
    this.store.transact((s) => {
      for (const k of s.keysWithPrefix('session:')) {
        if (s.getRef(k).epoch < epoch) s.delete(k);
      }
    });
    this.jwksCache = null;
  }

  sessionExists(sessionId) {
    return this.store.transact((s) => s.get(`session:${sessionId}`)) !== undefined;
  }
}
