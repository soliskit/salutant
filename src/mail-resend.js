// Resend mail adapter. Implements docs/mail/mock-mail-adapter-contract.md
// against the Resend API. The adapter is the only place the provider
// credential exists (contract rule 1): the API key arrives via the
// constructor and is never logged or exposed. No tracking, no open
// pixels, no rewritten links (contract rule 4): plain-text sends only.
//
// Uncertain sends (contract): a timeout or network failure means the send
// may or may not have happened. The service never retries automatically;
// it settles the send through reconcile(), which is strictly read-only:
// when the provider returned an id, reconcile reads that record (GET
// /emails/{id}) and maps it to sent / absent / unknown. Without a
// provider id there is no provider record to read, so reconcile returns
// unknown - it never re-sends. The one POST for a send carries the
// requestId as Resend's Idempotency-Key header as provider-side
// protection for that single call only (Resend keeps a key for 24h);
// reconcile never relies on it and never issues a POST.

const BASE_URL = 'https://api.resend.com';

/**
 * @typedef {{ outcome: 'accepted', providerId: string }
 *   | { outcome: 'uncertain' }
 *   | { outcome: 'failed' }} SendResult
 */
/**
 * @typedef {{ state: 'sent', providerId: string }
 *   | { state: 'absent' }
 *   | { state: 'unknown' }} ReconcileResult
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export class ResendMailAdapter {
  // apiKey: the Resend API key (Worker secret). from: the verified
  // sender, e.g. "Salutant <no-reply@example.test>". fetchImpl and
  // timeoutMs are injectable for tests.
  /**
   * @param {{ apiKey: string, from: string, fetchImpl?: typeof fetch,
   *   timeoutMs?: number }} options
   */
  constructor({
    apiKey,
    from,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  }) {
    if (!apiKey) throw new Error('adapter contract: apiKey is required');
    if (!from) throw new Error('adapter contract: from is required');
    this.apiKey = apiKey;
    this.from = from;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, { payload: object, providerId?: string }>} */
    this.sends = new Map(); // requestId -> { payload, providerId? }
  }

  /**
   * @param {{ requestId: string, to: string, subject: string, text: string }} message
   * @returns {Promise<SendResult>}
   */
  async send({ requestId, to, subject, text }) {
    if (!requestId) throw new Error('adapter contract: requestId is required');
    const payload = { from: this.from, to: [to], subject, text };
    this.sends.set(requestId, { payload });
    let res;
    try {
      res = await this.fetchImpl(`${BASE_URL}/emails`, {
        method: 'POST',
        headers: this.headers(requestId),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      // Timeout or network failure: the send may or may not have happened.
      return { outcome: 'uncertain' };
    }
    const body = await this.readJson(res);
    if (
      res.ok &&
      typeof body === 'object' &&
      body !== null &&
      'id' in body &&
      typeof body.id === 'string'
    ) {
      const record = this.sends.get(requestId);
      // The record was set above. A missing record rejects here, as the
      // unguarded property write did.
      if (record === undefined) throw new TypeError('send record is missing');
      record.providerId = body.id;
      return { outcome: 'accepted', providerId: body.id };
    }
    if (res.ok || res.status >= 500) return { outcome: 'uncertain' };
    // 4xx: the provider refused the send. This cannot produce a proof.
    return { outcome: 'failed' };
  }

  /**
   * @param {string} requestId
   * @returns {Promise<ReconcileResult>}
   */
  async reconcile(requestId) {
    if (!requestId) throw new Error('adapter contract: requestId is required');
    const record = this.sends.get(requestId);
    if (record && record.providerId) {
      // Read the provider's own record for the accepted send.
      let res;
      try {
        res = await this.fetchImpl(`${BASE_URL}/emails/${record.providerId}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch {
        return { state: 'unknown' };
      }
      if (res.ok) return { state: 'sent', providerId: record.providerId };
      if (res.status === 404) return { state: 'absent' };
      return { state: 'unknown' };
    }
    // No provider record to read without a providerId: the contract
    // settles uncertain sends without resending, so this stays unknown.
    return { state: 'unknown' };
  }

  /** @param {string} [idempotencyKey] */
  headers(idempotencyKey) {
    /** @type {Record<string, string>} */
    const h = { authorization: `Bearer ${this.apiKey}` };
    if (idempotencyKey) {
      h['content-type'] = 'application/json';
      h['idempotency-key'] = idempotencyKey;
    }
    return h;
  }

  /**
   * @param {Response} res
   * @returns {Promise<unknown>}
   */
  async readJson(res) {
    try {
      /** @type {unknown} */
      const value = await res.json();
      return value;
    } catch {
      return undefined;
    }
  }
}
