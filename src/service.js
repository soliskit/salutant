// Salutant mock service (lane C). Implements the lane A contract
// (docs/contract/lane-a-contract.md) against injected fakes: storage,
// mail, keys, clock and epoch are all provided, so phase 1 uses no real
// credentials and sends nothing. Failure is closed (R5): any internal
// error, unavailable state or unreadable epoch means nobody signs in.

import { respond } from './headers.js';
import {
  generateCode, randomId, timingSafeEqual, importHmacKey, hmacSha256,
  signProof, exportPublicJwk, toBase64Url, fromBase64Url,
} from './crypto.js';

export const DEFAULT_CONFIG = {
  codeTtlMs: 10 * 60_000,
  maxAttempts: 5,
  activeChallengesPerAddress: 2,
  sendsPerAddressPerHour: 3,
  requestsPerAddressPerHour: 10,
  requestsPerSourcePerHour: 10,
  resendCooldownMs: 60_000,
  sendsPerDay: 50,
  sendsPerMonth: 1500,
  bodyLimitBytes: 2048,
  proofTtlSeconds: 300,
  clockSkewMs: 60_000,
  endpointCacheSeconds: 300,
  keyCacheMs: 5 * 60_000,
  addressStateTtlMs: 24 * 3_600_000,
  challengePurgeMs: 3_600_000, // one hour after expiry: records never live 24h (R6)
};

const GENERIC_VERIFY_ERROR = 'invalid_or_expired_code';

export class SalutantService {
  constructor({
    store, mailer, epochSource,
    allowlist,           // exact addresses from service settings; never in the repo
    apps,                // [{ origin, callbackUrl }] exact matches only, no wildcards
    serviceOrigin,       // e.g. https://salutant.example.test in the mock
    codeHmacKeyBytes,    // a service secret in production
    stateHmacKeyBytes,   // a separate service secret for address/source-linked state
    signingKeys,         // Map kid -> { publicKey, privateKey, status, notAfterMs }
    currentKid,
    clock = () => Date.now(),
    logSink = [],
    config = {},
  }) {
    this.store = store;
    this.mailer = mailer;
    this.epochSource = epochSource;
    this.allowlist = new Set(allowlist);
    this.apps = apps;
    this.serviceOrigin = serviceOrigin;
    this.clock = clock;
    this.logSink = logSink;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.signingKeys = signingKeys;
    this.currentKid = currentKid;
    this.pendingSends = [];
    this._inflight = new Map(); // idempotency single-flight for concurrent duplicates
    this._keysReady = Promise.all([
      importHmacKey(codeHmacKeyBytes),
      importHmacKey(stateHmacKeyBytes),
    ]).then(([codeKey, stateKey]) => { this._codeKey = codeKey; this._stateKey = stateKey; });
  }

  async ready() { await this._keysReady; }

  // R13: time, event type, outcome and a hashed source. Never codes,
  // proofs or email addresses.
  log(event, outcome, source) {
    this.logSink.push({ time: new Date(this.clock()).toISOString(), event, outcome, source });
  }

  async _hmac(key, message) { return toBase64Url(await hmacSha256(key, message)); }

  async _epochOrClosed() {
    // R14: if the epoch cannot be read, the service stays closed.
    const epoch = await this.epochSource.read();
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('epoch unreadable');
    return epoch;
  }

  async fetch(request) {
    try {
      return await this._route(request);
    } catch {
      this.log('internal_error', 'closed', 'none');
      return respond(500, { error: 'unavailable' });
    }
  }

  async _route(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/challenges') {
      return this._createChallenge(request);
    }
    const verify = url.pathname.match(/^\/v1\/challenges\/([^/]+)\/verify$/);
    if (request.method === 'POST' && verify) {
      return this._verify(request, decodeURIComponent(verify[1]));
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      return this._jwks();
    }
    return respond(404, { error: 'not_found' });
  }

  _sourceOf(request) {
    // R6: the source address comes from the host's trusted header, never
    // a client-supplied one.
    return request.headers.get('cf-connecting-ip') ?? 'unknown';
  }

  async _jsonBody(request) {
    // R6: request bodies are bounded. Read with a hard cap.
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.config.bodyLimitBytes) return { tooBig: true };
      chunks.push(value);
    }
    try {
      return { body: JSON.parse(new TextDecoder().decode(concatBytes(chunks))) };
    } catch {
      return { bad: true };
    }
  }

  // POST /v1/challenges
  //
  // Body: { address, appOrigin, stateId } to start a challenge, or
  // { resendOf, address } to resend on an existing challenge. R3: the
  // response for an allowed and an unlisted address is byte-identical
  // apart from the request id, and never waits on the mail provider.
  async _createChallenge(request) {
    const epoch = await this._epochOrClosed(); // closed if unreadable
    const { tooBig, bad, body } = await this._jsonBody(request);
    if (tooBig || bad) return respond(400, { error: 'bad_request' });

    const sourceHash = await this._hmac(this._stateKey, `source:${this._sourceOf(request)}`);

    // Idempotency: a double-click is one request (R5). Concurrent
    // duplicates join the in-flight response; later duplicates get the
    // recorded response. Neither does new work or sends new mail.
    const idemKey = request.headers.get('idempotency-key');
    const replay = (recorded) => {
      const r = respond(recorded.status, recorded.body);
      // The replay must carry the original binding cookie, or a
      // fresh-browser retry could never verify the challenge it
      // already paid for (R2, R5).
      if (recorded.setCookie) r.headers.append('set-cookie', recorded.setCookie);
      return r;
    };
    if (idemKey) {
      const seen = this.store.transact((s) => s.get(`idem:${idemKey}`));
      if (seen) {
        this.log('challenge', 'duplicate', sourceHash);
        return replay(seen);
      }
      const flying = this._inflight.get(idemKey);
      if (flying) {
        this.log('challenge', 'duplicate', sourceHash);
        return replay(await flying);
      }
    }
    let markDone = null;
    if (idemKey) this._inflight.set(idemKey, new Promise((resolve) => { markDone = resolve; }));
    const respondAndRecord = (status, respBody, setCookie = null) => {
      if (idemKey) {
        const recorded = { status, body: respBody, setCookie, createdAtMs: this.clock() };
        this.store.transact((s) => s.set(`idem:${idemKey}`, recorded));
        markDone?.(recorded);
        this._inflight.delete(idemKey);
      }
      const r = respond(status, respBody);
      if (setCookie) r.headers.append('set-cookie', setCookie);
      return r;
    };

    const now = this.clock();
    if (body.resendOf) {
      return this._resend(body, epoch, now, sourceHash, respondAndRecord);
    }

    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const app = this.apps.find((a) => a.origin === body.appOrigin);
    if (!address || !app || typeof body.stateId !== 'string' || body.stateId.length < 16) {
      this.log('challenge', 'rejected_request', sourceHash);
      return respondAndRecord(400, { error: 'bad_request' });
    }
    const listed = this.allowlist.has(address);
    const challengeId = randomId(16);
    const requestId = randomId(16);
    const code = generateCode();
    const binding = randomId(24);
    // Every awaited step (keyed hashes) finishes here, BEFORE the gate.
    // The gate below is then one synchronous step with no await between
    // check and write, so concurrent requests cannot interleave between
    // the cap check and the reservation (R6, R8).
    const [addressHash, codeHmac, bindingHmac] = await Promise.all([
      this._hmac(this._stateKey, `addr:${address}`),
      this._hmac(this._codeKey, codeHmacMessage(app.origin, 'signin', challengeId, code)),
      this._hmac(this._codeKey, `binding:${challengeId}:${binding}`),
    ]);

    // R6: one synchronous step for the request counters. Listed and
    // unlisted addresses count the same way, so a limit response never
    // reveals an allowed address (R3).
    const gate = this.store.transact((s) => {
      if (bump(s, `reqsrc:${sourceHash}`, hourWindow(now), this.config.addressStateTtlMs, now) > this.config.requestsPerSourcePerHour) return 'rate_limited';
      if (bump(s, `reqaddr:${addressHash}`, hourWindow(now), this.config.addressStateTtlMs, now) > this.config.requestsPerAddressPerHour) return 'rate_limited';
      return null;
    });
    if (gate) {
      this.log('challenge', gate, sourceHash);
      return respondAndRecord(429, { error: 'rate_limited' });
    }

    // R8 + R6 in ONE synchronous step: the active-challenge cap, the
    // send budgets, the challenge write, the reservation write and the
    // counter bumps. No await inside, so no concurrent request can slip
    // between the checks and the writes. Every refusal verdict maps to the
    // identical generic response below (R3): a 429 here would reveal
    // that the address is on the list, because an unlisted address
    // never bumps its send counter.
    const verdict = this.store.transact((s) => {
      const openCount = s.keysWithPrefix('challenge:')
        .map((k) => s.getRef(k))
        .filter((c) => c.addressHash === addressHash && c.state === 'open' && c.expiresAtMs > now)
        .length;
      if (openCount >= this.config.activeChallengesPerAddress) return 'withheld_cap';
      if (readCounter(s, `sendaddr:${addressHash}`, hourWindow(now)) >= this.config.sendsPerAddressPerHour) return 'withheld_send_limit';
      if (readCounter(s, 'sendday', dayWindow(now)) >= this.config.sendsPerDay) return 'budget_spent';
      if (readCounter(s, 'sendmonth', monthWindow(now)) >= this.config.sendsPerMonth) return 'budget_spent';
      // Durable reservation in the same step (R5, contract: Atomic
      // state changes). Only after it exists may the adapter run. The
      // record carries the epoch (R14) and only keyed hashes of the
      // address (R2, R6); the address itself is never stored.
      s.set(`challenge:${challengeId}`, {
        id: challengeId, addressHash, appOrigin: app.origin, stateId: body.stateId,
        purpose: 'signin', codeHmac, bindingHmac, attempts: 0, state: 'open',
        epoch, createdAtMs: now, expiresAtMs: now + this.config.codeTtlMs,
        lastSentAtMs: now, listed, proofId: null, requestId,
      });
      s.set(`reservation:${requestId}`, {
        requestId, challengeId, addressHash, createdAtMs: now, epoch, outcome: 'pending',
      });
      if (listed) {
        bump(s, `sendaddr:${addressHash}`, hourWindow(now), this.config.addressStateTtlMs, now);
        bump(s, 'sendday', dayWindow(now), 2 * 24 * 3_600_000, now);
        bump(s, 'sendmonth', monthWindow(now), 32 * 24 * 3_600_000, now);
      }
      return 'accepted';
    });
    if (verdict !== 'accepted') {
      // EVERY refusal - active cap, per-address budget, global budget -
      // answers with the same generic 200, the same body shape and the
      // same cookie shape as an acceptance (R3, R8). The response must
      // never vary with the address class or with which limit fired:
      // any difference is a membership oracle.
      this.log('challenge', verdict, sourceHash);
      return withheldChallenge(respondAndRecord);
    }

    // The response never waits on the mail provider (R3); the send runs
    // after the reservation is durable and its result is recorded after.
    // An unlisted address costs no mail quota (R8) but gets the same
    // response and does the same storage work (R3).
    if (listed) {
      this.pendingSends.push(this._sendCode(requestId, address, code));
    } else {
      this.store.transact((s) => {
        const r = s.getRef(`reservation:${requestId}`);
        if (r) r.outcome = 'withheld_unlisted';
      });
    }
    this.log('challenge', 'accepted', sourceHash);

    // Bind the challenge to the browser that asked (R2 proposal): a
    // random value held only in that browser. Host-only, Secure,
    // HttpOnly, SameSite Strict, path-scoped to this challenge's verify
    // route. Same-origin first-party, so no third-party cookie is
    // needed (R16).
    const setCookie =
      `sb_${cookieNameFragment(challengeId)}=${binding}; Path=/v1/challenges/${encodeURIComponent(challengeId)}/verify; Secure; HttpOnly; SameSite=Strict`;
    return respondAndRecord(200, { status: 'ok', requestId, challengeId }, setCookie);
  }

  async _resend(body, epoch, now, sourceHash, respondAndRecord) {
    // R2: a resend gives its own challenge a new code and kills only
    // that challenge's earlier code. It reuses the slot (R8) and obeys
    // the resend cooldown.
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const peek = this.store.transact((s) => s.get(`challenge:${body.resendOf}`));
    if (!peek || !address) {
      return respondAndRecord(200, { status: 'ok', requestId: randomId(16), challengeId: randomId(16) });
    }
    // Every awaited step finishes here, BEFORE the gate. The gate below
    // is one synchronous step with no await between check and write, so
    // concurrent resends cannot all pass the cooldown and each send
    // mail (R2, R6).
    const requestId = randomId(16);
    const code = generateCode();
    const [addressHash, codeHmac] = await Promise.all([
      this._hmac(this._stateKey, `addr:${address}`),
      this._hmac(this._codeKey, codeHmacMessage(peek.appOrigin, 'signin', peek.id, code)),
    ]);
    if (addressHash !== peek.addressHash) {
      return respondAndRecord(200, { status: 'ok', requestId: randomId(16), challengeId: randomId(16) });
    }
    const verdict = this.store.transact((s) => {
      const c = s.getRef(`challenge:${peek.id}`);
      if (!c || c.state !== 'open' || c.expiresAtMs <= now || c.epoch !== epoch) return 'gone';
      if (now - c.lastSentAtMs < this.config.resendCooldownMs) return 'cooldown';
      if (c.listed) {
        if (readCounter(s, `sendaddr:${c.addressHash}`, hourWindow(now)) >= this.config.sendsPerAddressPerHour) return 'rate_limited';
        if (readCounter(s, 'sendday', dayWindow(now)) >= this.config.sendsPerDay) return 'budget_spent';
        if (readCounter(s, 'sendmonth', monthWindow(now)) >= this.config.sendsPerMonth) return 'budget_spent';
      }
      c.codeHmac = codeHmac; // the earlier code is dead from this moment
      c.lastSentAtMs = now;
      c.requestId = requestId;
      s.set(`reservation:${requestId}`, {
        requestId, challengeId: c.id, addressHash: c.addressHash, createdAtMs: now, epoch, outcome: 'pending',
      });
      if (c.listed) {
        bump(s, `sendaddr:${c.addressHash}`, hourWindow(now), this.config.addressStateTtlMs, now);
        bump(s, 'sendday', dayWindow(now), 2 * 24 * 3_600_000, now);
        bump(s, 'sendmonth', monthWindow(now), 32 * 24 * 3_600_000, now);
      }
      return 'accepted';
    });
    if (verdict === 'cooldown' || verdict === 'rate_limited' || verdict === 'budget_spent') {
      this.log('resend', verdict, sourceHash);
      return respond(429, { error: verdict });
    }
    if (verdict === 'gone') {
      return respondAndRecord(200, { status: 'ok', requestId: randomId(16), challengeId: peek.id });
    }
    if (peek.listed) {
      this.pendingSends.push(this._sendCode(requestId, address, code));
    }
    this.log('resend', 'accepted', sourceHash);
    return respondAndRecord(200, { status: 'ok', requestId, challengeId: peek.id });
  }

  async _sendCode(requestId, address, code) {
    // Acceptance is not delivery (R5): an uncertain send is not retried
    // automatically, counts against the budget, and is reconciled
    // against the provider's send record.
    const result = await this.mailer.send({
      requestId, to: address, subject: 'Your sign-in code',
      text: `Your sign-in code is ${code}. It expires in 10 minutes.`,
    });
    this.store.transact((s) => {
      const r = s.getRef(`reservation:${requestId}`);
      if (r) r.outcome = result.outcome;
    });
    if (result.outcome === 'uncertain') {
      const rec = await this.mailer.reconcile(requestId);
      this.store.transact((s) => {
        const r = s.getRef(`reservation:${requestId}`);
        if (r) r.reconciled = rec.state === 'sent' ? 'sent' : 'absent';
      });
    }
  }

  // POST /v1/challenges/{id}/verify   body: { code, address }
  //
  // One synchronous transaction does the whole state change: load,
  // check, compare, and either consume or count a wrong try (contract:
  // Atomic state changes). All failures give one generic error (R2).
  async _verify(request, challengeId) {
    const epoch = await this._epochOrClosed();
    const { tooBig, bad, body } = await this._jsonBody(request);
    if (tooBig || bad) return respond(400, { error: 'bad_request' });
    const sourceHash = await this._hmac(this._stateKey, `source:${this._sourceOf(request)}`);
    const now = this.clock();

    // Read-only step to learn the record's app origin so the keyed hash
    // of the submitted code can be computed outside the transaction.
    // The transaction below re-checks everything, so nothing here is
    // trusted.
    const peek = this.store.transact((s) => s.get(`challenge:${challengeId}`));
    const appOrigin = peek?.appOrigin ?? 'none';
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const code = typeof body.code === 'string' ? body.code : '';
    const binding = request.headers.get('cookie')
      ?.match(new RegExp(`(?:^|;\\s*)sb_${cookieNameFragment(challengeId)}=([^;]+)`))?.[1] ?? '';
    const [codeHmac, bindingHmac, addressHash] = await Promise.all([
      this._hmac(this._codeKey, codeHmacMessage(appOrigin, 'signin', challengeId, code)),
      this._hmac(this._codeKey, `binding:${challengeId}:${binding}`),
      this._hmac(this._stateKey, `addr:${address}`),
    ]);

    const outcome = this.store.transact((s) => {
      const c = s.getRef(`challenge:${challengeId}`);
      if (!c || !c.listed || c.state !== 'open' || c.expiresAtMs <= now || c.epoch !== epoch) {
        return { ok: false };
      }
      if (c.attempts >= this.config.maxAttempts) {
        c.state = 'dead';
        return { ok: false };
      }
      // R5: acceptance is not delivery. A challenge whose send failed,
      // was reconciled absent, or is still in flight verifies nothing -
      // the code it holds was never delivered. This check costs the
      // request no attempt: only a delivered code can be tried.
      const r = s.getRef(`reservation:${c.requestId}`);
      const delivered = r && (r.outcome === 'accepted' || r.reconciled === 'sent');
      if (!delivered) return { ok: false };
      const codeOk = timingSafeEqual(fromBase64Url(codeHmac), fromBase64Url(c.codeHmac));
      const bindingOk = timingSafeEqual(fromBase64Url(bindingHmac), fromBase64Url(c.bindingHmac));
      const addressOk = addressHash === c.addressHash;
      if (!codeOk || !bindingOk || !addressOk) {
        c.attempts += 1; // a wrong try is counted in the same step
        if (c.attempts >= this.config.maxAttempts) c.state = 'dead';
        return { ok: false };
      }
      c.state = 'consumed'; // consumed in the same step that verified it
      c.consumedAtMs = now;
      return { ok: true, appOrigin: c.appOrigin, stateId: c.stateId };
    });

    if (!outcome.ok) {
      this.log('verify', 'rejected', sourceHash);
      return respond(200, { error: GENERIC_VERIFY_ERROR });
    }

    const app = this.apps.find((a) => a.origin === outcome.appOrigin);
    const nowSeconds = Math.floor(now / 1000);
    const key = this.signingKeys.get(this.currentKid);
    const jti = randomId(16);
    // R4: pinned algorithm, minimal claims. sub is the address the app
    // needs - it lives only inside this signed proof, never in storage
    // or logs. The nonce is the state id the app opened with, so the
    // proof is bound to the transaction that started the sign-in.
    const proof = await signProof({
      iss: this.serviceOrigin,
      aud: outcome.appOrigin,
      sub: address,
      iat: nowSeconds, nbf: nowSeconds, exp: nowSeconds + this.config.proofTtlSeconds,
      kid: this.currentKid, jti, nonce: outcome.stateId, epoch,
    }, key.privateKey, this.currentKid);

    this.store.transact((s) => {
      const c = s.getRef(`challenge:${challengeId}`);
      if (c) c.proofId = jti;
      s.set(`issuance:${jti}`, {
        jti, challengeId, epoch, issuedAtMs: now,
        expiresAtMs: now + this.config.proofTtlSeconds * 1000,
      });
    });
    this.log('verify', 'proof_issued', sourceHash);
    return respond(200, { proof, state: outcome.stateId, callbackUrl: app.callbackUrl });
  }

  // GET /.well-known/jwks.json - public keys and the current epoch.
  // Cacheable for the endpoint-cache window and never longer (R12).
  async _jwks() {
    const epoch = await this._epochOrClosed();
    const now = this.clock();
    const keys = [];
    for (const [kid, k] of this.signingKeys) {
      if (k.status === 'revoked') continue;
      if (k.status === 'overlap' && k.notAfterMs <= now) continue;
      keys.push(await exportPublicJwk(k.publicKey, kid));
    }
    return respond(200, { keys, epoch }, { cache: { publicSeconds: this.config.endpointCacheSeconds } });
  }

  // Housekeeping used by tests and by the future alarm-driven purge.
  // Deleting storage does not erase point-in-time recovery (contract:
  // Cost and limits check); the epoch rule is what keeps a restored
  // copy safe (R14).
  purge(now = this.clock()) {
    this.store.transact((s) => {
      for (const k of s.keysWithPrefix('challenge:')) {
        if (s.getRef(k).expiresAtMs + this.config.challengePurgeMs <= now) s.delete(k);
      }
      for (const k of s.keysWithPrefix('counter:')) {
        if (s.getRef(k).expiresAtMs <= now) s.delete(k);
      }
      for (const k of s.keysWithPrefix('reservation:')) {
        if (s.getRef(k).createdAtMs + this.config.addressStateTtlMs <= now) s.delete(k);
      }
      for (const k of s.keysWithPrefix('issuance:')) {
        if (s.getRef(k).expiresAtMs + this.config.challengePurgeMs <= now) s.delete(k);
      }
      for (const k of s.keysWithPrefix('idem:')) {
        if (s.getRef(k).createdAtMs + this.config.addressStateTtlMs <= now) s.delete(k);
      }
    });
  }

  // Test hook: wait for fire-and-forget sends to settle.
  async drain() { await Promise.allSettled(this.pendingSends); }
}

export function codeHmacMessage(appOrigin, purpose, challengeId, code) {
  return `${appOrigin}|${purpose}|${challengeId}|${code}`;
}

export function cookieNameFragment(challengeId) {
  return challengeId.replaceAll('-', '_');
}

// The generic refusal: random stand-in ids and a binding-shaped cookie,
// indistinguishable from an acceptance on the wire (R3). The ids name
// no record and the cookie binds nothing.
function withheldChallenge(respondAndRecord) {
  const requestId = randomId(16);
  const challengeId = randomId(16);
  const binding = randomId(24);
  const setCookie =
    `sb_${cookieNameFragment(challengeId)}=${binding}; Path=/v1/challenges/${encodeURIComponent(challengeId)}/verify; Secure; HttpOnly; SameSite=Strict`;
  return respondAndRecord(200, { status: 'ok', requestId, challengeId }, setCookie);
}

function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function hourWindow(now) { return `h:${Math.floor(now / 3_600_000)}`; }
function dayWindow(now) { return `d:${new Date(now).toISOString().slice(0, 10)}`; }
function monthWindow(now) { return `m:${new Date(now).toISOString().slice(0, 7)}`; }

// Counter records carry their own expiry, so address-linked state never
// outlives its window while the plain day and month totals live to the
// end of their period (R6).
function bump(s, kind, window, ttlMs, now) {
  const key = `counter:${kind}:${window}`;
  const rec = s.getRef(key) ?? { count: 0, expiresAtMs: now + ttlMs };
  rec.count += 1;
  s.set(key, rec);
  return rec.count;
}

function readCounter(s, kind, window) {
  return s.getRef(`counter:${kind}:${window}`)?.count ?? 0;
}
