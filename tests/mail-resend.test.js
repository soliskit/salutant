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

/**
 * @typedef {{ status: number, body?: unknown, rawBody?: string }
 *   | { throw: string }} Handler
 */

// A fetch stand-in that answers from a queue of handlers with real
// Response objects. The adapter reads only ok, status and json(), and a
// real Response derives ok from status and fails json() on a non-JSON body.
// Each recorded call keeps the url, method, headers and string body.
/** @param {Handler[]} handlers */
function stubFetch(handlers) {
  /** @type {{ url: string, method: string | undefined, headers: Headers, body: string | undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const impl = async (input, init = {}) => {
    assert.ok(typeof input === 'string', 'the adapter passes a string url');
    calls.push({
      url: input,
      method: init.method,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined
    });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected fetch to ${input}`);
    if ('throw' in h) throw new Error(h.throw);
    return new Response(h.rawBody ?? JSON.stringify(h.body), {
      status: h.status
    });
  };
  return Object.assign(impl, { calls });
}

/** @param {typeof fetch} fetchImpl */
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
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.get('idempotency-key'), 'req-1');
  assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`);
  assert.ok(call.body !== undefined, 'the send carries a string body');
  const body = JSON.parse(call.body);
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
  assert.equal(f.calls[1].method, undefined);
});

void test('reconcile of accepted send: 404 is absent, 5xx and network failure are unknown', async () => {
  /** @type {[Handler, { state: string }][]} */
  const cases = [
    [{ status: 404, body: {} }, { state: 'absent' }],
    [{ status: 500, body: {} }, { state: 'unknown' }],
    [{ throw: 'reset' }, { state: 'unknown' }]
  ];
  for (const [h, want] of cases) {
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
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].headers.get('idempotency-key'), 'req-1');
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
  assert.equal(f.calls[0].method, 'POST');
  assert.notEqual(f.calls[1].method, 'POST');
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
