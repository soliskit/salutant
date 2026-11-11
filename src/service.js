// Salutant mock service. Runs the whole sign-in logic
// against injected fakes: storage,
// mail, keys, clock and epoch are all provided, so phase 1 uses no real
// credentials and sends nothing. Failure is closed (R5): any internal
// error, unavailable state or unreadable epoch means nobody signs in.

import { respond } from './headers.js';
import {
  generateCode,
  randomId,
  timingSafeEqual,
  importHmacKey,
  hmacSha256,
  signProof,
  exportPublicJwk,
  toBase64Url,
  fromBase64Url
} from './crypto.js';

export const DEFAULT_CONFIG = {
  codeTtlMs: 30 * 60_000,
  maxAttempts: 3,
  activeChallengesPerAddress: 2,
  sendsPerAddressPer30Minutes: 3,
  requestsPerAddressPerHour: 10,
  requestsPerSourcePerHour: 10,
  resendCooldownMs: 60_000,
  sendsPerDay: 90,
  sendsPerMonth: 2700,
  bodyLimitBytes: 2048,
  proofTtlSeconds: 300,
  clockSkewMs: 60_000,
  endpointCacheSeconds: 300,
  keyCacheMs: 5 * 60_000,
  addressStateTtlMs: 24 * 3_600_000,
  challengePurgeMs: 3_600_000, // one hour after expiry: records never live 24h (R6)
  logRetentionMs: 14 * 24 * 3_600_000 // service logs are kept 14 days
};

// How long the daily and monthly send totals are kept: two days and 32 days.
const DAY_COUNTER_TTL_MS = 2 * 24 * 3_600_000;
const MONTH_COUNTER_TTL_MS = 32 * 24 * 3_600_000;

const GENERIC_VERIFY_ERROR = 'invalid_or_expired_code';

/**
 * @typedef {{ status: number, body: Record<string, unknown>, setCookie: string | null }} ReplayRecord
 * @typedef {{ owner: Request, promise: Promise<ReplayRecord>, settle: (recorded: ReplayRecord) => void }} InflightRequest
 */

/**
 * @typedef {object} ServiceStore
 * @property {(key: unknown) => unknown} get
 * @property {(key: unknown) => unknown} getRef
 * @property {(key: unknown, value: unknown) => void} set
 * @property {(key: unknown) => void} delete
 * @property {(prefix: string) => unknown[]} keysWithPrefix
 * @property {<T>(fn: (store: ServiceStore) => T) => T} transact
 * @typedef {{ send(message: {requestId: string, to: string, subject: string, text: string}): Promise<import('./mail-resend.js').SendResult>, reconcile(requestId: string): Promise<import('./mail-resend.js').ReconcileResult> }} ServiceMailer
 * @typedef {{ publicKey: CryptoKey, privateKey: CryptoKey, status: unknown, notAfterMs: unknown }} SigningKey
 * @typedef {{store: ServiceStore, mailer: ServiceMailer,
 * epochSource: {read(): Promise<unknown>},
 * allowlist: Iterable<unknown> | null | undefined, apps: unknown,
 * serviceOrigin: string, codeHmacKeyBytes: BufferSource,
 * stateHmacKeyBytes: BufferSource,
 * signingKeys: Map<unknown, SigningKey>, currentKid: unknown,
 * clock?: () => number,
 * logSink?: Array<{time: string, event: string, outcome: string, source: string}>,
 * config?: Partial<typeof DEFAULT_CONFIG>}} ServiceOptions
 */
export class SalutantService {
  /** @param {ServiceOptions} options */
  constructor({
    store,
    mailer,
    epochSource,
    allowlist, // exact addresses from service settings; never in the repo
    apps, // [{ origin, callbackUrl }] exact matches only, no wildcards
    serviceOrigin, // e.g. https://salutant.example.test in the mock
    codeHmacKeyBytes, // a service secret in production
    stateHmacKeyBytes, // a separate service secret for address/source-linked state
    signingKeys, // Map kid -> { publicKey, privateKey, status, notAfterMs }
    currentKid,
    clock = () => Date.now(),
    logSink = /** @type {Array<{ time: string, event: string, outcome: string, source: string }>} */ ([]),
    config = {}
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
    /** @type {Promise<void>[]} */
    this.pendingSends = [];
    /** @type {Map<string | null, InflightRequest>} */
    this._inflight = new Map(); // idempotency single-flight for concurrent duplicates
    this._keysReady = Promise.all([
      importHmacKey(codeHmacKeyBytes),
      importHmacKey(stateHmacKeyBytes)
    ]).then(([codeKey, stateKey]) => {
      this._codeKey = codeKey;
      this._stateKey = stateKey;
      return undefined;
    });
  }

  async ready() {
    await this._keysReady;
  }

  // R13: time, event type, outcome and a hashed source. Never codes,
  // proofs or email addresses.
  // Entries older than the retention period are dropped when the next
  // event is logged.
  /**
   * @param {string} event
   * @param {string} outcome
   * @param {string} source
   */
  log(event, outcome, source) {
    const oldest = this.clock() - this.config.logRetentionMs;
    while (
      this.logSink.length > 0 &&
      Date.parse(this.logSink[0].time) < oldest
    ) {
      this.logSink.shift();
    }
    this.logSink.push({
      time: new Date(this.clock()).toISOString(),
      event,
      outcome,
      source
    });
  }

  /**
   * @param {CryptoKey} key
   * @param {string} message
   */
  async _hmac(key, message) {
    return toBase64Url(await hmacSha256(key, message));
  }

  /** @returns {Promise<number>} */
  async _epochOrClosed() {
    // R14: if the epoch cannot be read, the service stays closed.
    /** @type {unknown} */
    const epoch = await this.epochSource.read();
    if (!isEpoch(epoch)) throw new Error('epoch unreadable');
    return epoch;
  }

  /** @param {Request} request */
  async fetch(request) {
    try {
      return await this._route(request);
    } catch {
      this.log('internal_error', 'closed', 'none');
      return respond(500, { error: 'unavailable' });
    }
  }

  /** @param {Request} request */
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

  /** @param {Request} request */
  _sourceOf(request) {
    // R6: the source address comes from the host's trusted header, never
    // a client-supplied one.
    return request.headers.get('cf-connecting-ip') ?? 'unknown';
  }

  /**
   * @param {Request} request
   * @returns {Promise<{ tooBig?: true, bad?: true, body?: unknown }>}
   */
  async _jsonBody(request) {
    // R6: request bodies are bounded. Read with a hard cap.
    const stream = request.body;
    if (stream === null) throw new TypeError('request has no body');
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.config.bodyLimitBytes) return { tooBig: true };
      chunks.push(value);
    }
    /** @type {unknown} */
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(concatBytes(chunks)));
    } catch {
      return { bad: true };
    }
    return { body };
  }

  // POST /v1/challenges
  //
  // Body: { address, appOrigin, stateId } to start a challenge, or
  // { resendOf, address } to resend on an existing challenge. R3: the
  // response for an allowed and an unlisted address is byte-identical
  // apart from the request id, and never waits on the mail provider.
  /** @param {Request} request */
  async _createChallenge(request) {
    try {
      return await this._createChallengeBody(request);
    } catch (err) {
      // An entry this request registered must not outlive it: a same-key
      // retry would wait on it forever (R5). Settle waiters with the same
      // closed answer a thrown request gets, record nothing, and rethrow.
      const key = request.headers.get('idempotency-key');
      const flying = this._inflight.get(key);
      if (flying && flying.owner === request) {
        this._inflight.delete(key);
        flying.settle({
          status: 500,
          body: { error: 'unavailable' },
          setCookie: null
        });
      }
      throw err;
    }
  }

  /** @param {Request} request */
  async _createChallengeBody(request) {
    const epoch = await this._epochOrClosed(); // closed if unreadable
    const { tooBig, bad, body } = await this._jsonBody(request);
    if (tooBig || bad) return respond(400, { error: 'bad_request' });

    const sourceHash = await this._hmac(
      this._stateKey,
      `source:${this._sourceOf(request)}`
    );

    // Idempotency: a double-click is one request (R5). Concurrent
    // duplicates join the in-flight response; later duplicates get the
    // recorded response. Neither does new work or sends new mail.
    const idemKey = request.headers.get('idempotency-key');
    /** @param {unknown} recorded */
    const replay = (recorded) => {
      const r = respond(
        storedFields(recorded).status === undefined
          ? undefined
          : Number(storedFields(recorded).status),
        replayBody(storedFields(recorded).body)
      );
      // The replay must carry the original binding cookie, or a
      // fresh-browser retry could never verify the challenge it
      // already paid for (R2, R5).
      if (storedFields(recorded).setCookie)
        r.headers.append(
          'set-cookie',
          String(storedFields(recorded).setCookie)
        );
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
        return replay(await flying.promise);
      }
    }
    /** @type {((recorded: ReplayRecord) => void) | null} */
    let markDone = null;
    if (idemKey) {
      /** @type {PromiseWithResolvers<ReplayRecord>} */
      const { promise, resolve } = Promise.withResolvers();
      markDone = resolve;
      this._inflight.set(idemKey, {
        promise,
        settle: resolve,
        owner: request
      });
    }
    /**
     * @param {number} status
     * @param {Record<string, unknown>} respBody
     * @param {string | null} [setCookie]
     */
    const respondAndRecord = (
      status,
      respBody,
      /** @type {string | null} */ setCookie = null
    ) => {
      if (idemKey) {
        const recorded = {
          status,
          body: respBody,
          setCookie,
          createdAtMs: this.clock()
        };
        this.store.transact((s) => {
          s.set(`idem:${idemKey}`, recorded);
        });
        markDone?.(recorded);
        this._inflight.delete(idemKey);
      }
      const r = respond(status, respBody);
      if (setCookie) r.headers.append('set-cookie', setCookie);
      return r;
    };

    const now = this.clock();
    if (body === null) throw new TypeError('request body is null');
    const fields = fieldsOf(body);
    if (fields.resendOf) {
      return this._resend(fields, epoch, now, sourceHash, respondAndRecord);
    }

    const address =
      typeof fields.address === 'string' ? fields.address.trim() : '';
    const app = configuredApps(this.apps).find(
      (app) => configuredAppOrigin(app) === fields.appOrigin
    );
    if (
      !address ||
      !app ||
      typeof fields.stateId !== 'string' ||
      fields.stateId.length < 16
    ) {
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
      this._hmac(
        this._codeKey,
        codeHmacMessage(storedFields(app).origin, 'signin', challengeId, code)
      ),
      this._hmac(this._codeKey, `binding:${challengeId}:${binding}`)
    ]);

    // R6: one synchronous step for the request counters. Listed and
    // unlisted addresses count the same way, so a limit response never
    // reveals an allowed address (R3).
    const gate = this.store.transact((s) => {
      if (
        bump(
          s,
          `reqsrc:${sourceHash}`,
          hourWindow(now),
          this.config.addressStateTtlMs,
          now
        ) > this.config.requestsPerSourcePerHour
      )
        return 'rate_limited';
      if (
        bump(
          s,
          `reqaddr:${addressHash}`,
          hourWindow(now),
          this.config.addressStateTtlMs,
          now
        ) > this.config.requestsPerAddressPerHour
      )
        return 'rate_limited';
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
      const openCount = s
        .keysWithPrefix('challenge:')
        .map((k) => s.getRef(k))
        .filter(
          (c) =>
            storedFields(c).addressHash === addressHash &&
            storedFields(c).state === 'open' &&
            Number(storedFields(c).expiresAtMs) > now
        ).length;
      if (openCount >= this.config.activeChallengesPerAddress)
        return 'withheld_cap';
      const overBudget =
        readRecentSends(s, addressHash, now) >=
          this.config.sendsPerAddressPer30Minutes ||
        readCounter(s, 'sendday', dayWindow(now)) >= this.config.sendsPerDay ||
        readCounter(s, 'sendmonth', monthWindow(now)) >=
          this.config.sendsPerMonth;
      if (overBudget) {
        // R3: a budget refusal does the SAME storage work as an
        // unlisted acceptance (challenge + reservation, real ids, real
        // binding) so resends and cooldowns evolve identically for
        // every class. The reservation outcome 'withheld' can never be
        // delivered, so verify always rejects it (R5), and no send
        // budget is touched because no mail goes out.
        s.set(`challenge:${challengeId}`, {
          id: challengeId,
          addressHash,
          appOrigin: storedFields(app).origin,
          stateId: fields.stateId,
          purpose: 'signin',
          codeHmac,
          bindingHmac,
          attempts: 0,
          state: 'open',
          epoch,
          createdAtMs: now,
          expiresAtMs: now + this.config.codeTtlMs,
          lastSentAtMs: now,
          listed,
          proofId: null,
          requestId
        });
        s.set(`reservation:${requestId}`, {
          requestId,
          challengeId,
          addressHash,
          createdAtMs: now,
          epoch,
          outcome: 'withheld'
        });
        return 'withheld_send_limit';
      }
      // Durable reservation, written in the same step as the
      // check (R5). Only after it exists may the adapter run. The
      // record carries the epoch (R14) and only keyed hashes of the
      // address (R2, R6); the address itself is never stored.
      s.set(`challenge:${challengeId}`, {
        id: challengeId,
        addressHash,
        appOrigin: storedFields(app).origin,
        stateId: fields.stateId,
        purpose: 'signin',
        codeHmac,
        bindingHmac,
        attempts: 0,
        state: 'open',
        epoch,
        createdAtMs: now,
        expiresAtMs: now + this.config.codeTtlMs,
        lastSentAtMs: now,
        listed,
        proofId: null,
        requestId
      });
      s.set(`reservation:${requestId}`, {
        requestId,
        challengeId,
        addressHash,
        createdAtMs: now,
        epoch,
        outcome: 'pending'
      });
      if (listed) {
        recordSend(s, addressHash, this.config.addressStateTtlMs, now);
        bump(s, 'sendday', dayWindow(now), DAY_COUNTER_TTL_MS, now);
        bump(s, 'sendmonth', monthWindow(now), MONTH_COUNTER_TTL_MS, now);
      }
      return 'accepted';
    });
    if (verdict === 'withheld_cap') {
      // The cap refusal is class-uniform (every address hits it with
      // full slots), so stand-in ids and a stand-in cookie reveal
      // nothing; no record exists to bind.
      this.log('challenge', verdict, sourceHash);
      return withheldChallenge(respondAndRecord);
    }
    if (verdict === 'withheld_send_limit') {
      // Budget refusal: the record exists (written in the gate above),
      // so answer with its real ids and real binding cookie - on the
      // wire this is indistinguishable from an acceptance (R3).
      this.log('challenge', verdict, sourceHash);
      const refusedCookie = `sb_${cookieNameFragment(challengeId)}=${binding}; Path=/v1/challenges/${encodeURIComponent(challengeId)}/verify; Secure; HttpOnly; SameSite=Strict`;
      return respondAndRecord(
        200,
        { status: 'ok', requestId, challengeId },
        refusedCookie
      );
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
        if (r) writeStoredField(r, 'outcome', 'withheld_unlisted');
      });
    }
    this.log('challenge', 'accepted', sourceHash);

    // Bind the challenge to the browser that asked (R2 proposal): a
    // random value held only in that browser. Host-only, Secure,
    // HttpOnly, SameSite Strict, path-scoped to this challenge's verify
    // route. Same-origin first-party, so no third-party cookie is
    // needed (R16).
    const setCookie = `sb_${cookieNameFragment(challengeId)}=${binding}; Path=/v1/challenges/${encodeURIComponent(challengeId)}/verify; Secure; HttpOnly; SameSite=Strict`;
    return respondAndRecord(
      200,
      { status: 'ok', requestId, challengeId },
      setCookie
    );
  }

  /**
   * @param {Record<string, unknown>} body
   * @param {number} epoch
   * @param {number} now
   * @param {string} sourceHash
   * @param {(status: number, body: Record<string, unknown>, setCookie?: string | null) => Response} respondAndRecord
   */
  async _resend(body, epoch, now, sourceHash, respondAndRecord) {
    // R2: a resend gives its own challenge a new code and kills only
    // that challenge's earlier code. It reuses the slot (R8) and obeys
    // the resend cooldown.
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const addressHash = await this._hmac(this._stateKey, `addr:${address}`);

    // R6: one synchronous step for the request counters, exactly as on
    // challenge creation. A resend is a request: it bumps the same
    // hourly source and address counters, so the request limits hold
    // across both paths. Listed and unlisted addresses - and made-up
    // resend targets - count the same way, so a limit response never
    // reveals an allowed address (R3).
    const gate = this.store.transact((s) => {
      if (
        bump(
          s,
          `reqsrc:${sourceHash}`,
          hourWindow(now),
          this.config.addressStateTtlMs,
          now
        ) > this.config.requestsPerSourcePerHour
      )
        return 'rate_limited';
      if (
        bump(
          s,
          `reqaddr:${addressHash}`,
          hourWindow(now),
          this.config.addressStateTtlMs,
          now
        ) > this.config.requestsPerAddressPerHour
      )
        return 'rate_limited';
      return null;
    });
    if (gate) {
      this.log('resend', gate, sourceHash);
      return respondAndRecord(429, { error: gate });
    }

    const peek = this.store.transact((s) =>
      s.get(`challenge:${String(body.resendOf)}`)
    );
    if (!peek || !address) {
      return respondAndRecord(200, {
        status: 'ok',
        requestId: randomId(16),
        challengeId: randomId(16)
      });
    }
    // Every awaited step finishes here, BEFORE the gate. The gate below
    // is one synchronous step with no await between check and write, so
    // concurrent resends cannot all pass the cooldown and each send
    // mail (R2, R6).
    const requestId = randomId(16);
    const code = generateCode();
    const codeHmac = await this._hmac(
      this._codeKey,
      codeHmacMessage(
        storedFields(peek).appOrigin,
        'signin',
        storedFields(peek).id,
        code
      )
    );
    if (addressHash !== storedFields(peek).addressHash) {
      return respondAndRecord(200, {
        status: 'ok',
        requestId: randomId(16),
        challengeId: randomId(16)
      });
    }
    const verdict = this.store.transact((s) => {
      const c = s.getRef(`challenge:${String(storedFields(peek).id)}`);
      if (
        !c ||
        storedFields(c).state !== 'open' ||
        Number(storedFields(c).expiresAtMs) <= now ||
        storedFields(c).epoch !== epoch
      )
        return 'gone';
      if (
        now - Number(storedFields(c).lastSentAtMs) <
        this.config.resendCooldownMs
      )
        return 'cooldown';
      if (storedFields(c).listed) {
        const overBudget =
          readRecentSends(s, storedFields(c).addressHash, now) >=
            this.config.sendsPerAddressPer30Minutes ||
          readCounter(s, 'sendday', dayWindow(now)) >=
            this.config.sendsPerDay ||
          readCounter(s, 'sendmonth', monthWindow(now)) >=
            this.config.sendsPerMonth;
        if (overBudget) {
          // A withheld resend moves the cooldown clock exactly like an
          // accepted one (R3): identical state evolution, so an
          // immediate retry meets the same cooldown for every class.
          // The earlier code is NOT rotated - this refusal sent no
          // mail, so the owner's last delivered code stays valid.
          writeStoredField(c, 'lastSentAtMs', now);
          return 'withheld_send_limit';
        }
      }
      writeStoredField(c, 'codeHmac', codeHmac); // the earlier code is dead from this moment
      writeStoredField(c, 'lastSentAtMs', now);
      writeStoredField(c, 'requestId', requestId);
      s.set(`reservation:${requestId}`, {
        requestId,
        challengeId: storedFields(c).id,
        addressHash: storedFields(c).addressHash,
        createdAtMs: now,
        epoch,
        outcome: 'pending'
      });
      if (storedFields(c).listed) {
        recordSend(
          s,
          storedFields(c).addressHash,
          this.config.addressStateTtlMs,
          now
        );
        bump(s, 'sendday', dayWindow(now), DAY_COUNTER_TTL_MS, now);
        bump(s, 'sendmonth', monthWindow(now), MONTH_COUNTER_TTL_MS, now);
      }
      return 'accepted';
    });
    if (verdict === 'cooldown') {
      // The cooldown is class-uniform (it keys on the challenge's own
      // last-sent time, bumped for every accepted challenge), so a 429
      // here reveals no membership.
      this.log('resend', verdict, sourceHash);
      // Record the refusal too: a keyed duplicate must resolve with it,
      // not wait on a response that never settles (R5).
      return respondAndRecord(429, { error: verdict });
    }
    if (verdict === 'withheld_send_limit') {
      // Budget refusals use the same uniform withheld path as challenge
      // creation (R3): the per-address send counter only moves for
      // listed addresses, so a 429 here would be a membership oracle.
      this.log('resend', verdict, sourceHash);
      return respondAndRecord(200, {
        status: 'ok',
        requestId: randomId(16),
        challengeId: storedFields(peek).id
      });
    }
    if (verdict === 'gone') {
      return respondAndRecord(200, {
        status: 'ok',
        requestId: randomId(16),
        challengeId: storedFields(peek).id
      });
    }
    if (storedFields(peek).listed) {
      this.pendingSends.push(this._sendCode(requestId, address, code));
    }
    this.log('resend', 'accepted', sourceHash);
    return respondAndRecord(200, {
      status: 'ok',
      requestId,
      challengeId: storedFields(peek).id
    });
  }

  /**
   * @param {string} requestId
   * @param {string} address
   * @param {string} code
   */
  async _sendCode(requestId, address, code) {
    // Acceptance is not delivery (R5): an uncertain send is not retried
    // automatically, counts against the budget, and is reconciled
    // against the provider's send record.
    const result = await this.mailer.send({
      requestId,
      to: address,
      subject: 'Your sign-in code',
      text: `Your sign-in code is ${code}. It expires ${String(this.config.codeTtlMs / 60_000)} minutes after the original request.`
    });
    this.store.transact((s) => {
      const r = s.getRef(`reservation:${requestId}`);
      if (r) writeStoredField(r, 'outcome', result.outcome);
    });
    if (result.outcome === 'uncertain') {
      const rec = await this.mailer.reconcile(requestId);
      this.store.transact((s) => {
        const r = s.getRef(`reservation:${requestId}`);
        if (r)
          writeStoredField(
            r,
            'reconciled',
            rec.state === 'sent' ? 'sent' : 'absent'
          );
      });
    }
  }

  // POST /v1/challenges/{id}/verify   body: { code, address }
  //
  // One synchronous transaction does the whole state change: load,
  // check, compare, and either consume or count a wrong try, with no wait in between.
  // A rejected challenge or code gives one generic error (R2).
  /**
   * @param {Request} request
   * @param {string} challengeId
   */
  async _verify(request, challengeId) {
    const epoch = await this._epochOrClosed();
    const { tooBig, bad, body } = await this._jsonBody(request);
    if (tooBig || bad) return respond(400, { error: 'bad_request' });
    const sourceHash = await this._hmac(
      this._stateKey,
      `source:${this._sourceOf(request)}`
    );
    const now = this.clock();

    // Read-only step to learn the record's app origin so the keyed hash
    // of the submitted code can be computed outside the transaction.
    // The transaction below re-checks everything, so nothing here is
    // trusted.
    const peek = this.store.transact((s) => s.get(`challenge:${challengeId}`));
    const appOrigin =
      peek === null || peek === undefined
        ? 'none'
        : (storedFields(peek).appOrigin ?? 'none');
    if (body === null) throw new TypeError('request body is null');
    const fields = fieldsOf(body);
    const address =
      typeof fields.address === 'string' ? fields.address.trim() : '';
    const code = typeof fields.code === 'string' ? fields.code : '';
    const binding =
      request.headers
        .get('cookie')
        ?.match(
          new RegExp(`(?:^|;\\s*)sb_${cookieNameFragment(challengeId)}=([^;]+)`)
        )?.[1] ?? '';
    const [codeHmac, bindingHmac, addressHash] = await Promise.all([
      this._hmac(
        this._codeKey,
        codeHmacMessage(appOrigin, 'signin', challengeId, code)
      ),
      this._hmac(this._codeKey, `binding:${challengeId}:${binding}`),
      this._hmac(this._stateKey, `addr:${address}`)
    ]);

    const outcome = this.store.transact((s) => {
      const c = s.getRef(`challenge:${challengeId}`);
      if (
        !c ||
        !storedFields(c).listed ||
        storedFields(c).state !== 'open' ||
        Number(storedFields(c).expiresAtMs) <= now ||
        storedFields(c).epoch !== epoch
      ) {
        return { ok: false };
      }
      if (Number(storedFields(c).attempts) >= this.config.maxAttempts) {
        writeStoredField(c, 'state', 'dead');
        return { ok: false };
      }
      // R5: acceptance is not delivery. A challenge whose send failed,
      // was reconciled absent, or is still in flight verifies nothing -
      // the code it holds was never delivered. This check costs the
      // request no attempt: only a delivered code can be tried.
      const r = s.getRef(`reservation:${String(storedFields(c).requestId)}`);
      const delivered =
        r &&
        (storedFields(r).outcome === 'accepted' ||
          storedFields(r).reconciled === 'sent');
      if (!delivered) return { ok: false };
      const codeOk = timingSafeEqual(
        fromBase64Url(codeHmac),
        fromBase64Url(storedString(storedFields(c).codeHmac))
      );
      const bindingOk = timingSafeEqual(
        fromBase64Url(bindingHmac),
        fromBase64Url(storedString(storedFields(c).bindingHmac))
      );
      const addressOk = addressHash === storedFields(c).addressHash;
      if (!codeOk || !bindingOk || !addressOk) {
        writeStoredField(
          c,
          'attempts',
          addStoredNumber(storedFields(c).attempts, 1)
        ); // a wrong try is counted in the same step
        if (Number(storedFields(c).attempts) >= this.config.maxAttempts)
          writeStoredField(c, 'state', 'dead');
        return { ok: false };
      }
      writeStoredField(c, 'state', 'consumed'); // consumed in the same step that verified it
      writeStoredField(c, 'consumedAtMs', now);
      return {
        ok: true,
        appOrigin: storedFields(c).appOrigin,
        stateId: storedFields(c).stateId
      };
    });

    if (!outcome.ok) {
      this.log('verify', 'rejected', sourceHash);
      return respond(200, { error: GENERIC_VERIFY_ERROR });
    }

    const app = configuredApps(this.apps).find(
      (app) => configuredAppOrigin(app) === outcome.appOrigin
    );
    const nowSeconds = Math.floor(now / 1000);
    const key = this.signingKeys.get(this.currentKid);
    const jti = randomId(16);
    // R4: pinned algorithm, minimal claims. sub is the address the app
    // needs - it lives only inside this signed proof, never in storage
    // or logs. The nonce is the state id the app opened with, so the
    // proof is bound to the transaction that started the sign-in.
    const proof = await signProof(
      {
        iss: this.serviceOrigin,
        aud: outcome.appOrigin,
        sub: address,
        iat: nowSeconds,
        nbf: nowSeconds,
        exp: nowSeconds + this.config.proofTtlSeconds,
        kid: this.currentKid,
        jti,
        nonce: outcome.stateId,
        epoch
      },
      signingPrivateKey(key),
      this.currentKid
    );

    this.store.transact((s) => {
      const c = s.getRef(`challenge:${challengeId}`);
      if (c) writeStoredField(c, 'proofId', jti);
      s.set(`issuance:${jti}`, {
        jti,
        challengeId,
        epoch,
        issuedAtMs: now,
        expiresAtMs: now + this.config.proofTtlSeconds * 1000
      });
    });
    this.log('verify', 'proof_issued', sourceHash);
    return respond(200, {
      proof,
      state: outcome.stateId,
      callbackUrl: storedFields(app).callbackUrl
    });
  }

  // GET /.well-known/jwks.json - public keys and the current epoch.
  // Cacheable for the endpoint-cache window and never longer (R12).
  async _jwks() {
    const epoch = await this._epochOrClosed();
    const now = this.clock();
    const keys = [];
    for (const [kid, k] of this.signingKeys) {
      if (k.status === 'revoked') continue;
      if (k.status === 'overlap' && Number(k.notAfterMs) <= now) continue;
      keys.push(await exportPublicJwk(k.publicKey, kid));
    }
    return respond(
      200,
      { keys, epoch },
      { cache: { publicSeconds: this.config.endpointCacheSeconds } }
    );
  }

  // Housekeeping used by tests and by the future alarm-driven purge.
  // Deleting storage does not erase point-in-time recovery; the epoch rule is what keeps a restored
  // copy safe (R14).
  purge(now = this.clock()) {
    this.store.transact((s) => {
      for (const k of s.keysWithPrefix('challenge:')) {
        if (
          Number(
            addStoredNumber(
              storedFields(s.get(k)).expiresAtMs,
              this.config.challengePurgeMs
            )
          ) <= now
        )
          s.delete(k);
      }
      for (const k of s.keysWithPrefix('counter:')) {
        if (Number(storedFields(s.get(k)).expiresAtMs) <= now) s.delete(k);
      }
      for (const k of s.keysWithPrefix('reservation:')) {
        if (
          Number(
            addStoredNumber(
              storedFields(s.get(k)).createdAtMs,
              this.config.addressStateTtlMs
            )
          ) <= now
        )
          s.delete(k);
      }
      for (const k of s.keysWithPrefix('issuance:')) {
        if (
          Number(
            addStoredNumber(
              storedFields(s.get(k)).expiresAtMs,
              this.config.challengePurgeMs
            )
          ) <= now
        )
          s.delete(k);
      }
      for (const k of s.keysWithPrefix('idem:')) {
        if (
          Number(
            addStoredNumber(
              storedFields(s.get(k)).createdAtMs,
              this.config.addressStateTtlMs
            )
          ) <= now
        )
          s.delete(k);
      }
    });
  }

  // Test hook: wait for fire-and-forget sends to settle.
  async drain() {
    await Promise.allSettled(this.pendingSends);
  }
}

/**
 * @param {unknown} appOrigin
 * @param {string} purpose
 * @param {unknown} challengeId
 * @param {string} code
 */
export function codeHmacMessage(appOrigin, purpose, challengeId, code) {
  return `${String(appOrigin)}|${purpose}|${String(challengeId)}|${code}`;
}

/** @param {string} challengeId */
export function cookieNameFragment(challengeId) {
  return challengeId.replaceAll('-', '_');
}

// The generic refusal: random stand-in ids and a binding-shaped cookie,
// indistinguishable from an acceptance on the wire (R3). The ids name
// no record and the cookie binds nothing.
/**
 * @param {(status: number, body: Record<string, unknown>, setCookie?: string | null) => Response} respondAndRecord
 */
function withheldChallenge(respondAndRecord) {
  const requestId = randomId(16);
  const challengeId = randomId(16);
  const binding = randomId(24);
  const setCookie = `sb_${cookieNameFragment(challengeId)}=${binding}; Path=/v1/challenges/${encodeURIComponent(challengeId)}/verify; Secure; HttpOnly; SameSite=Strict`;
  return respondAndRecord(
    200,
    { status: 'ok', requestId, challengeId },
    setCookie
  );
}

/**
 * Field view of a parsed JSON body. Objects and arrays are returned as
 * they are; primitives have no fields, as before.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function fieldsOf(value) {
  if (typeof value !== 'object' || value === null) return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Uint8Array[]} chunks */
function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// Rolling send reservations cover (now - 30 minutes, now]. Creates and
// resends check and record in the same synchronous transaction. Failed or
// uncertain sends still consume quota; refusals never add a timestamp.
const SEND_WINDOW_MS = 30 * 60_000;
/**
 * @param {ServiceStore} s
 * @param {unknown} addressHash
 * @param {number} now
 */
function recentSends(s, addressHash, now) {
  const record = s.getRef(`counter:sendaddr:${String(addressHash)}:rolling`);
  const timestamps =
    record === null || record === undefined
      ? []
      : (storedFields(record).timestamps ?? []);
  if (!Array.isArray(timestamps))
    throw new TypeError('stored timestamps do not provide filter');
  const values = /** @type {unknown[]} */ (timestamps);
  return values.filter((time) => Number(time) > now - SEND_WINDOW_MS);
}
/**
 * @param {ServiceStore} s
 * @param {unknown} addressHash
 * @param {number} now
 */
function readRecentSends(s, addressHash, now) {
  return recentSends(s, addressHash, now).length;
}
/**
 * @param {ServiceStore} s
 * @param {unknown} addressHash
 * @param {number} ttlMs
 * @param {number} now
 */
function recordSend(s, addressHash, ttlMs, now) {
  const timestamps = recentSends(s, addressHash, now);
  timestamps.push(now);
  s.set(`counter:sendaddr:${String(addressHash)}:rolling`, {
    timestamps,
    expiresAtMs: now + ttlMs
  });
}
/** @param {number} now */
function hourWindow(now) {
  return `h:${String(Math.floor(now / 3_600_000))}`;
}
/** @param {number} now */
function dayWindow(now) {
  return `d:${new Date(now).toISOString().slice(0, 10)}`;
}
/** @param {number} now */
function monthWindow(now) {
  return `m:${new Date(now).toISOString().slice(0, 7)}`;
}

// Counter records carry their own expiry, so address-linked state never
// outlives its window while the plain day and month totals live to the
// end of their period (R6).
/**
 * @param {ServiceStore} s
 * @param {string} kind
 * @param {string} window
 * @param {number} ttlMs
 * @param {number} now
 */
function bump(s, kind, window, ttlMs, now) {
  const key = `counter:${kind}:${window}`;
  const rec = s.getRef(key) ?? { count: 0, expiresAtMs: now + ttlMs };
  writeStoredField(rec, 'count', addStoredNumber(storedFields(rec).count, 1));
  s.set(key, rec);
  return Number(storedFields(rec).count);
}

/**
 * @param {ServiceStore} s
 * @param {string} kind
 * @param {string} window
 */
function readCounter(s, kind, window) {
  const record = s.getRef(`counter:${kind}:${window}`);
  return record === null || record === undefined
    ? 0
    : Number(storedFields(record).count ?? 0);
}

/**
 * A safe integer is a number; the second check excludes negative epochs.
 * @param {unknown} value
 * @returns {value is number}
 */
function isEpoch(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** @param {unknown} value */
function storedFields(value) {
  if (value === null || value === undefined)
    throw new TypeError('stored value has no members');
  /** @type {unknown} */
  const boxed = Object(value);
  return /** @type {Record<string, unknown>} */ (boxed);
}
/** @param {unknown} target @param {string} key @param {unknown} value */
function writeStoredField(target, key, value) {
  if (typeof target !== 'object')
    throw new TypeError('stored value cannot be written');
  const fields = /** @type {Record<string, unknown>} */ (target);
  fields[key] = value;
}
/** @param {unknown} value */
function storedString(value) {
  if (typeof value !== 'string')
    throw new TypeError('stored value is not a string');
  return value;
}
/** @param {unknown} value @param {number} amount */
function addStoredNumber(value, amount) {
  if (typeof value === 'object' && value !== null)
    throw new TypeError('stored additive operand is not a scalar');
  if (typeof value === 'string') return value + String(amount);
  return Number(value) + amount;
}
/** @param {unknown} apps */
export function configuredApps(apps) {
  if (!Array.isArray(apps))
    throw new TypeError('configured apps are not an array');
  return /** @type {unknown[]} */ (apps);
}
/** @param {unknown} app */
export function configuredAppOrigin(app) {
  return storedFields(app).origin;
}

/** @param {SigningKey | undefined} key */
function signingPrivateKey(key) {
  if (key === undefined) throw new TypeError('signing key is missing');
  return key.privateKey;
}
/** @param {unknown} value */
function replayBody(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object')
    return /** @type {Record<string, unknown>} */ (value);
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      throw new TypeError('stored response body is not a JSON value');
  }
}
