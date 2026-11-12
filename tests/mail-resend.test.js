// Contract-parity tests for the real Resend adapter
// (docs/mail/mock-mail-adapter-contract.md). Same outcomes the mock
// proves locally: accepted / uncertain / failed, and reconcile states
// sent / absent / unknown. All network I/O is stubbed; no credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResendMailAdapter } from '../src/mail-resend.js';

const FROM = 'Salutant <no-reply@example.test>';
const KEY = 're_test_key';
const MSG = {
  requestId: 'req-1',
  to: 'owner@example.test',
  subject: 'Your sign-in code',
  text: 'Your sign-in code is 123456.'
};

function stubFetch(handlers) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected fetch to ${url}`);
    if (h.throw) throw new Error(h.throw);
    return {
      ok: h.ok ?? (h.status >= 200 && h.status < 300),
      status: h.status,
      json: async () => {
        if (h.rawBody !== undefined) throw new SyntaxError('Unexpected token');
        return h.body;
      }
    };
  };
  impl.calls = calls;
  return impl;
}

function adapter(fetchImpl) {
  return new ResendMailAdapter({ apiKey: KEY, from: FROM, fetchImpl });
}

void test('constructor requires apiKey and from', () => {
  assert.throws(
    () => new ResendMailAdapter({ from: FROM }),
    /apiKey is required/
  );
  assert.throws(
    () => new ResendMailAdapter({ apiKey: KEY }),
    /from is required/
  );
});

void test('send requires requestId', async () => {
  const a = adapter(stubFetch([]));
  await assert.rejects(
    () => a.send({ to: MSG.to, subject: MSG.subject, text: MSG.text }),
    /requestId is required/
  );
  await assert.rejects(() => a.reconcile(''), /requestId is required/);
});

void test('accepted send: returns providerId, sends idempotency key and plain-text payload', async () => {
  const f = stubFetch([{ status: 200, body: { id: 'prov-1' } }]);
  const a = adapter(f);
  const r = await a.send(MSG);
  assert.deepEqual(r, { outcome: 'accepted', providerId: 'prov-1' });
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['idempotency-key'], 'req-1');
  assert.equal(call.opts.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(call.opts.body);
  assert.deepEqual(body, {
    from: FROM,
    to: [MSG.to],
    subject: MSG.subject,
    text: MSG.text
  });
});

void test('provider refusal (4xx) is failed, not retried', async () => {
  const f = stubFetch([{ status: 422, body: { message: 'invalid' } }]);
  const a = adapter(f);
  assert.deepEqual(await a.send(MSG), { outcome: 'failed' });
  assert.equal(f.calls.length, 1);
});

void test('5xx and network failure are uncertain', async () => {
  const f1 = stubFetch([{ status: 500, body: {} }]);
  assert.deepEqual(await adapter(f1).send(MSG), { outcome: 'uncertain' });
  const f2 = stubFetch([{ throw: 'socket hangup' }]);
  assert.deepEqual(await adapter(f2).send(MSG), { outcome: 'uncertain' });
});

void test('2xx without a provider id is uncertain', async () => {
  const f = stubFetch([{ status: 200, body: {} }]);
  assert.deepEqual(await adapter(f).send(MSG), { outcome: 'uncertain' });
});

void test('reconcile after accepted reads the provider record', async () => {
  const f = stubFetch([
    { status: 200, body: { id: 'prov-1' } },
    { status: 200, body: { id: 'prov-1', last_event: 'delivered' } }
  ]);
  const a = adapter(f);
  await a.send(MSG);
  const r = await a.reconcile('req-1');
  assert.deepEqual(r, { state: 'sent', providerId: 'prov-1' });
  assert.equal(f.calls[1].url, 'https://api.resend.com/emails/prov-1');
  assert.equal(f.calls[1].opts.method, undefined);
});

void test('reconcile of accepted send: 404 is absent, 5xx and network failure are unknown', async () => {
  for (const [h, want] of [
    [{ status: 404, body: {} }, { state: 'absent' }],
    [{ status: 500, body: {} }, { state: 'unknown' }],
    [{ throw: 'reset' }, { state: 'unknown' }]
  ]) {
    const f = stubFetch([{ status: 200, body: { id: 'prov-1' } }, h]);
    const a = adapter(f);
    await a.send(MSG);
    assert.deepEqual(await a.reconcile('req-1'), want);
  }
});

void test('reconcile after uncertain with no providerId is unknown and never re-sends', async () => {
  const f = stubFetch([
    { throw: 'timeout' },
    { status: 200, body: { id: 'prov-1' } }
  ]);
  const a = adapter(f);
  assert.deepEqual(await a.send(MSG), { outcome: 'uncertain' });
  assert.deepEqual(await a.reconcile('req-1'), { state: 'unknown' });
  // Contract: reconcile settles without resending. It must make no call
  // at all here, and the only POST ever issued is the original send.
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(f.calls[0].opts.headers['idempotency-key'], 'req-1');
});

void test('reconcile after accepted reads the provider record and never POSTs', async () => {
  const f = stubFetch([
    { status: 200, body: { id: 'prov-1' } },
    { status: 200, body: {} }
  ]);
  const a = adapter(f);
  assert.deepEqual(await a.send(MSG), {
    outcome: 'accepted',
    providerId: 'prov-1'
  });
  assert.deepEqual(await a.reconcile('req-1'), {
    state: 'sent',
    providerId: 'prov-1'
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.notEqual(f.calls[1].opts.method, 'POST');
  assert.match(f.calls[1].url, /\/emails\/prov-1$/);
});

void test('reconcile of an unknown requestId is unknown', async () => {
  const a = adapter(stubFetch([]));
  assert.deepEqual(await a.reconcile('nope'), { state: 'unknown' });
});

void test('a non-JSON provider body is uncertain, not accepted', async () => {
  // The provider answered 200 but the body is not JSON (a proxy or
  // outage page): no provider id can be read, so the send is uncertain
  // and reconcile has no record to settle it.
  const f = stubFetch([{ status: 200, rawBody: '<html>Bad Gateway</html>' }]);
  const a = adapter(f);
  assert.deepEqual(await a.send(MSG), { outcome: 'uncertain' });
  assert.deepEqual(await a.reconcile('req-1'), { state: 'unknown' });
  assert.equal(f.calls.length, 1);
});

void test('an accepted response rejects if the send record disappeared while awaiting fetch', async () => {
  const f = stubFetch([{ status: 200, body: { id: 'prov-1' } }]);
  const a = adapter(async (url, opts) => {
    assert.equal(a.sends.delete(MSG.requestId), true);
    return f(url, opts);
  });
  await assert.rejects(() => a.send(MSG), TypeError);
  assert.equal(f.calls.length, 1);
});
