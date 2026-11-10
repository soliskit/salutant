// Mock mail adapter. Implements docs/mail/mock-mail-adapter-contract.md
// with no network I/O and no credentials. Provider-neutral: the service
// cannot tell this from a future Gmail or Resend adapter (decision 2).

export class MockMailAdapter {
  // behavior: "ok" | "uncertain" | "failed" | (message) => outcome
  /**
   * @param {{ behavior?: string | ((message: { requestId: string, to: string, subject: string, text: string }) => string) }} [options]
   */
  constructor({ behavior = 'accepted' } = {}) {
    this.behavior = behavior;
    /** @type {Array<{ requestId: string, providerId: string, to: string, subject: string, text: string, acceptedAt: number }>} */
    this.outbox = []; // every accepted message, readable by tests
    /** @type {Array<{ requestId: string, to: string, subject: string, outcome: string }>} */
    this.attempts = []; // every send call, including uncertain/failed
    /** @type {string[]} */
    this.reconciliations = [];
  }

  /**
   * @param {{ requestId: string, to: string, subject: string, text: string }} message
   * @returns {Promise<{ outcome: 'accepted', providerId: string } | { outcome: 'uncertain' } | { outcome: 'failed' }>}
   */
  send(message) {
    try {
      const { requestId, to, subject, text } = message;
      if (!requestId)
        throw new Error('adapter contract: requestId is required');
      const outcome =
        typeof this.behavior === 'function'
          ? this.behavior({ requestId, to, subject, text })
          : this.behavior;
      this.attempts.push({ requestId, to, subject, outcome });
      if (outcome === 'accepted') {
        const providerId = `mock-${String(this.outbox.length + 1)}`;
        this.outbox.push({
          requestId,
          providerId,
          to,
          subject,
          text,
          acceptedAt: Date.now()
        });
        return Promise.resolve({ outcome: 'accepted', providerId });
      }
      if (outcome === 'uncertain')
        return Promise.resolve({ outcome: 'uncertain' });
      return Promise.resolve({ outcome: 'failed' });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error
          : new Error('mock mail adapter failed', { cause: error });
      return Promise.reject(reason);
    }
  }

  /**
   * @param {string} requestId
   * @returns {Promise<{ state: 'sent', providerId: string } | { state: 'absent' } | { state: 'unknown' }>}
   */
  reconcile(requestId) {
    try {
      this.reconciliations.push(requestId);
      const hit = this.outbox.find((m) => m.requestId === requestId);
      if (hit)
        return Promise.resolve({ state: 'sent', providerId: hit.providerId });
      return Promise.resolve({ state: 'absent' });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error
          : new Error('mock mail adapter failed', { cause: error });
      return Promise.reject(reason);
    }
  }

  lastCode() {
    const last = this.outbox.at(-1);
    const m = last?.text.match(/\b(\d{6})\b/);
    return m ? m[1] : undefined;
  }
}
