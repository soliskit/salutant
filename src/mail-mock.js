// Mock mail adapter. Implements docs/mail/mock-mail-adapter-contract.md
// with no network I/O and no credentials. Provider-neutral: the service
// cannot tell this from a future Gmail or Resend adapter (decision 2).

export class MockMailAdapter {
  // behavior: "ok" | "uncertain" | "failed" | (message) => outcome
  constructor({ behavior = 'accepted' } = {}) {
    this.behavior = behavior;
    this.outbox = [];        // every accepted message, readable by tests
    this.attempts = [];      // every send call, including uncertain/failed
    this.reconciliations = [];
  }

  async send({ requestId, to, subject, text }) {
    if (!requestId) throw new Error('adapter contract: requestId is required');
    const outcome = typeof this.behavior === 'function' ? this.behavior({ requestId, to, subject, text }) : this.behavior;
    this.attempts.push({ requestId, to, subject, outcome });
    if (outcome === 'accepted') {
      const providerId = `mock-${this.outbox.length + 1}`;
      this.outbox.push({ requestId, providerId, to, subject, text, acceptedAt: Date.now() });
      return { outcome: 'accepted', providerId };
    }
    if (outcome === 'uncertain') return { outcome: 'uncertain' };
    return { outcome: 'failed' };
  }

  async reconcile(requestId) {
    this.reconciliations.push(requestId);
    const hit = this.outbox.find((m) => m.requestId === requestId);
    if (hit) return { state: 'sent', providerId: hit.providerId };
    return { state: 'absent' };
  }

  lastCode() {
    const last = this.outbox.at(-1);
    const m = last?.text.match(/\b(\d{6})\b/);
    return m ? m[1] : undefined;
  }
}
