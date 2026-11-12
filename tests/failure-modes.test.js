// R5 closed on failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockMailAdapter } from '../src/mail-mock.js';
import { makeWorld, BrowserSession, OWNER } from './helpers.js';

void test('an uncertain send is not retried, counts against budget, and is reconciled', async () => {
  let captured;
  const w = await makeWorld({
    mailerBehavior: ({ text }) => {
      const match = text.match(/\b(\d{6})\b/);
      assert.ok(match !== null, 'mock mail text has no six-digit code');
      captured = match[1];
      return 'uncertain';
    }
  });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  ).json();
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 1, 'no automatic retry');
  assert.equal(
    w.mailer.reconciliations.length,
    1,
    'reconciled against the provider record'
  );
  const reservation = w.store.transact((s) =>
    s.getRef([...s.keysWithPrefix('reservation:')][0])
  );
  assert.ok(
    typeof reservation === 'object' &&
      reservation !== null &&
      'outcome' in reservation &&
      'reconciled' in reservation
  );
  assert.equal(reservation.outcome, 'uncertain');
  assert.equal(
    reservation.reconciled,
    'absent',
    'the provider has no record of the send'
  );
  assert.ok(
    w.store.keysWithPrefix('counter:sendday:').length === 1,
    'budget counted'
  );
  // R5: with no provider record the code was never delivered, so even the
  // exact code verifies nothing.
  const res = await browser.verify({
    challengeId: created.challengeId,
    code: captured,
    address: OWNER
  });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
});

void test('a failed send means no proof and a recorded reservation', async () => {
  const w = await makeWorld({ mailerBehavior: 'failed' });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  ).json();
  await w.service.drain();
  const reservation = w.store.transact((s) =>
    s.getRef(`reservation:${created.requestId}`)
  );
  assert.ok(
    typeof reservation === 'object' &&
      reservation !== null &&
      'outcome' in reservation
  );
  assert.equal(reservation.outcome, 'failed');
  // The person can still retry after the cooldown: service stays up.
  w.advance(61_000);
  const res = await browser.resend({
    challengeId: created.challengeId,
    address: OWNER
  });
  assert.ok([200, 429].includes(res.status));
});

void test('a double-click is one request', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const key = 'click-123';
  const [r1, r2] = await Promise.all([
    browser.postChallenge({
      address: OWNER,
      stateId: start.stateId,
      idempotencyKey: key
    }),
    browser.postChallenge({
      address: OWNER,
      stateId: start.stateId,
      idempotencyKey: key
    })
  ]);
  await w.service.drain();
  const [b1, b2] = [await r1.json(), await r2.json()];
  assert.equal(b1.requestId, b2.requestId);
  assert.equal(b1.challengeId, b2.challengeId);
  assert.equal(w.mailer.outbox.length, 1, 'one mail for one logical request');
  assert.equal(w.store.keysWithPrefix('challenge:').length, 1);
});

// Narrow a stored challenge to an object that carries stateId. Its writers
// (service.js, both challenge writes) always include it. The test fails here,
// not at a later read, if the record is missing or not an object.
/** @param {unknown} value */
function challengeRecord(value) {
  assert.ok(typeof value === 'object' && value !== null && 'stateId' in value);
  return value;
}

void test('a request without an idempotency header stays separate from the literal key null', async () => {
  const w = await makeWorld();
  const browser1 = new BrowserSession(w);
  const browser2 = new BrowserSession(w);
  const first = await w.app.startSignIn(null);
  const second = await w.app.startSignIn(null);
  assert.notEqual(
    first.stateId,
    second.stateId,
    'setup requires separate pending states'
  );
  const firstResponse = await browser1.postChallenge({
    address: OWNER,
    stateId: first.stateId,
    idempotencyKey: 'null'
  });
  const firstBody = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.status, 'ok');
  await w.service.drain();
  const secondResponse = await browser2.postChallenge({
    address: OWNER,
    stateId: second.stateId
  });
  const secondBody = await secondResponse.json();
  await w.service.drain();
  assert.equal(secondResponse.status, 200);
  assert.equal(secondBody.status, 'ok');
  const secondChallenge = w.store.get(`challenge:${secondBody.challengeId}`);
  assert.ok(secondChallenge, 'the fresh request has a saved challenge');
  assert.equal(challengeRecord(secondChallenge).stateId, second.stateId);
  assert.equal(
    challengeRecord(w.store.get(`challenge:${firstBody.challengeId}`)).stateId,
    first.stateId
  );
  assert.equal(
    w.mailer.attempts.length,
    2,
    'each independent request sends once'
  );
});

void test('a storage failure closes the service: no send, plain message', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const realTransact = w.store.transact.bind(w.store);
  w.store.transact = () => {
    throw new Error('storage gone');
  };
  const res = await browser.postChallenge({
    address: OWNER,
    stateId: start.stateId
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'unavailable' });
  await w.service.drain();
  assert.equal(
    w.mailer.attempts.length,
    0,
    'nothing sent when the reservation write fails'
  );
  w.store.transact = realTransact;
});

void test('an unreadable epoch closes every route', async () => {
  const w = await makeWorld();
  w.epoch.available = false;
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  for (const res of [
    await browser.postChallenge({ address: OWNER, stateId: start.stateId }),
    await browser.verify({ challengeId: 'x', code: '000000', address: OWNER }),
    await w.service.fetch(
      new Request('https://salutant.example.test/.well-known/jwks.json')
    )
  ]) {
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'unavailable' });
  }
});

void test('provider timeout: the person can resend after the cooldown and sign in', async () => {
  let call = 0;
  const w = await makeWorld({
    mailerBehavior: () => (++call === 1 ? 'uncertain' : 'accepted')
  });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  ).json();
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 1);
  w.advance(61_000);
  await browser.resend({ challengeId: created.challengeId, address: OWNER });
  await w.service.drain();
  assert.equal(
    w.mailer.attempts.length,
    2,
    'a person-driven resend, not an automatic retry'
  );
  const code = w.mailer.lastCode();
  const ok = await browser.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER
  });
  const verified = await ok.json();
  assert.ok(verified.proof);
  // The resent code must complete the whole sign-in: the exchange
  // window runs from proof issuance, so a resend after the 60s
  // cooldown is not shut out.
  const exchange = await w.app.handleExchange(
    { proof: verified.proof, state: verified.state },
    'https://salutant.example.test'
  );
  assert.equal(exchange.status, 200, 'resent proof exchanges');
  const complete = await w.app.handleComplete(`pre=${start.cookieValue}`);
  assert.equal(complete.status, 200, 'resent sign-in completes');
});

void test('a failed send cannot verify: the undelivered code is dead on arrival', async () => {
  let captured;
  const w = await makeWorld({
    mailerBehavior: ({ text }) => {
      const match = text.match(/\d{6}/);
      assert.ok(match !== null, 'mock mail text has no six-digit code');
      captured = match[0];
      return 'failed';
    }
  });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  ).json();
  await w.service.drain();
  const reservation = w.store.transact((s) =>
    s.getRef(`reservation:${created.requestId}`)
  );
  assert.ok(
    typeof reservation === 'object' &&
      reservation !== null &&
      'outcome' in reservation
  );
  assert.equal(reservation.outcome, 'failed');
  // Even with the exact code in hand, verify issues no proof: the send
  // failed, so the reservation was never delivered (R5).
  const res = await browser.verify({
    challengeId: created.challengeId,
    code: captured,
    address: OWNER
  });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
});

void test('an idempotent replay carries the binding cookie, so a fresh-browser retry can verify', async () => {
  const w = await makeWorld();
  const browser1 = new BrowserSession(w);
  const browser2 = new BrowserSession(w); // the retry, after the first response was lost
  const start = await w.app.startSignIn(null);
  const key = 'retry-abc';
  await browser1.postChallenge({
    address: OWNER,
    stateId: start.stateId,
    idempotencyKey: key
  });
  const replay = await browser2.postChallenge({
    address: OWNER,
    stateId: start.stateId,
    idempotencyKey: key
  });
  assert.ok(
    replay.headers.getSetCookie().length > 0,
    'replay re-sends the binding cookie'
  );
  await w.service.drain();
  const code = w.mailer.lastCode();
  const created = await replay.json();
  const ok = await browser2.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER
  });
  assert.ok(
    (await ok.json()).proof,
    'the retrying browser is bound and can verify'
  );
});

// Request id, send results and reconcile results follow docs/mail/mock-mail-adapter-contract.md;
// the mock's provider id format and lastCode() are the mock's own conventions.
void test('mock mail adapter: request id required, accepted sends, reconcile results, last code', async () => {
  const mail = new MockMailAdapter();
  assert.equal(mail.lastCode(), undefined, 'no code before any send');
  await assert.rejects(
    () => mail.send({ to: OWNER, subject: 's', text: 't' }),
    /requestId is required/
  );
  assert.equal(
    mail.attempts.length,
    0,
    'a call without a request id records nothing'
  );
  const first = await mail.send({
    requestId: 'r1',
    to: OWNER,
    subject: 's1',
    text: 'code 123456'
  });
  const second = await mail.send({
    requestId: 'r2',
    to: OWNER,
    subject: 's2',
    text: 'no code here'
  });
  assert.deepEqual(
    first,
    { outcome: 'accepted', providerId: 'mock-1' },
    'default behavior accepts'
  );
  assert.deepEqual(second, { outcome: 'accepted', providerId: 'mock-2' });
  assert.deepEqual(
    mail.attempts.map((a) => [a.requestId, a.outcome]),
    [
      ['r1', 'accepted'],
      ['r2', 'accepted']
    ]
  );
  assert.deepEqual(await mail.reconcile('r2'), {
    state: 'sent',
    providerId: second.providerId
  });
  assert.deepEqual(await mail.reconcile('r1'), {
    state: 'sent',
    providerId: first.providerId
  });
  assert.deepEqual(await mail.reconcile('r3'), { state: 'absent' });
  assert.deepEqual(mail.reconciliations, ['r2', 'r1', 'r3']);
  assert.equal(
    mail.lastCode(),
    undefined,
    'the last message has no six-digit code'
  );
  await mail.send({
    requestId: 'r4',
    to: OWNER,
    subject: 's4',
    text: 'code 654321'
  });
  assert.equal(mail.lastCode(), '654321');
});

// The adapter contract promises Promise returns (docs/mail/mock-mail-adapter-contract.md);
// failures reject instead of throwing synchronously, even when the failure comes from
// inside the mock's own state.
void test('mock mail adapter: internal failures reject, never throw synchronously', async () => {
  const mail = new MockMailAdapter({
    behavior: () => {
      throw new Error('provider exploded');
    }
  });
  const sendResult = mail.send({
    requestId: 'r1',
    to: OWNER,
    subject: 's',
    text: 't'
  });
  assert.ok(sendResult instanceof Promise, 'send returns a promise');
  await assert.rejects(sendResult, /provider exploded/);

  const poisoned = new MockMailAdapter();
  poisoned.outbox = /** @type {typeof poisoned.outbox} */ (
    /** @type {unknown} */ ({
      find() {
        throw new Error('corrupt outbox');
      }
    })
  );
  const reconcileResult = poisoned.reconcile('r1');
  assert.ok(reconcileResult instanceof Promise, 'reconcile returns a promise');
  await assert.rejects(reconcileResult, /corrupt outbox/);
});

// R5: sending fails after the reservation is written. The provider is called
// once and reports failure; repeating the same request (same idempotency key)
// returns the same answer and sends nothing. The existing test 'a failed send
// cannot verify' already covers the refused code; it is asserted again here
// only so one test shows the whole sequence.
void test('after a failed send the provider is called once, and repeating the same request sends nothing', async () => {
  let sentCode;
  const w = await makeWorld({
    mailerBehavior: ({ text }) => {
      const match = text.match(/\b(\d{6})\b/);
      assert.ok(match !== null, 'mock mail text has no six-digit code');
      sentCode = match[1];
      return 'failed';
    }
  });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const key = 'failed-send-key-1';
  const created = await (
    await browser.postChallenge({
      address: OWNER,
      stateId: start.stateId,
      idempotencyKey: key
    })
  ).json();
  await w.service.drain();
  const reservation = w.store.transact((s) =>
    s.getRef(`reservation:${created.requestId}`)
  );
  assert.ok(
    typeof reservation === 'object' &&
      reservation !== null &&
      'outcome' in reservation
  );
  assert.equal(reservation.outcome, 'failed');
  assert.equal(w.mailer.attempts.length, 1, 'the provider was called once');
  const res = await browser.verify({
    challengeId: created.challengeId,
    code: sentCode,
    address: OWNER
  });
  assert.deepEqual(
    await res.json(),
    { error: 'invalid_or_expired_code' },
    'the undelivered code is refused'
  );
  const replay = await new BrowserSession(w).postChallenge({
    address: OWNER,
    stateId: start.stateId,
    idempotencyKey: key
  });
  assert.equal((await replay.json()).requestId, created.requestId);
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 1, 'the replay sent nothing');
});

// R5: if a request throws after it registered its idempotency key, a retry
// with the same key must be answered, not wait on the dead request.
void test('a request that throws after registering its key does not block a same-key retry', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const key = 'throws-after-register';
  const original = w.store.transact.bind(w.store);
  let armed = true;
  w.store.transact = (fn) =>
    original((s) => {
      const own = Object.getOwnPropertyDescriptor(s, 'set');
      const set = s.set.bind(s);
      s.set = (k, v) => {
        if (armed && String(k).startsWith('idem:')) {
          armed = false;
          throw new Error('injected write failure');
        }
        set(k, v);
      };
      try {
        return fn(s);
      } finally {
        if (own) Object.defineProperty(s, 'set', own);
        else Reflect.deleteProperty(s, 'set');
      }
    });
  const first = await browser.postChallenge({
    address: OWNER,
    stateId: start.stateId,
    idempotencyKey: key
  });
  assert.equal(first.status, 500, 'the failed request is closed');
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  const retry = await Promise.race([
    new BrowserSession(w).postChallenge({
      address: OWNER,
      stateId: start.stateId,
      idempotencyKey: key
    }),
    new Promise((resolve) => {
      retryTimer = setTimeout(() => {
        resolve('hung');
      }, 2000);
    })
  ]).finally(() => {
    clearTimeout(retryTimer);
  });
  assert.notEqual(retry, 'hung', 'the same-key retry is answered');
});

void test('a request that throws before registering its key leaves no stale entry for a same-key retry', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const key = 'throws-before-register';
  w.epoch.available = false;
  const first = await new BrowserSession(w).postChallenge({
    address: OWNER,
    stateId: start.stateId,
    idempotencyKey: key
  });
  assert.equal(first.status, 500, 'the service stays closed');
  w.epoch.available = true;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  const retry = await Promise.race([
    new BrowserSession(w).postChallenge({
      address: OWNER,
      stateId: start.stateId,
      idempotencyKey: key
    }),
    new Promise((resolve) => {
      retryTimer = setTimeout(() => {
        resolve('hung');
      }, 2000);
    })
  ]).finally(() => {
    clearTimeout(retryTimer);
  });
  assert.notEqual(retry, 'hung', 'the same-key retry is answered');
  assert.equal(retry.status, 200, 'and it is a normal first answer');
});

// Fails a test that waits on a request the service never answers.
/**
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label
 * @returns {Promise<T>}
 */
function within(promise, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(label));
    }, 2000);
  });
  return Promise.race([promise, limit]).finally(() => {
    clearTimeout(timer);
  });
}

void test('a duplicate already waiting on a request that then throws gets the closed 500, and a later same-key retry works', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const key = 'duplicate-waits-then-throws';
  const body = { address: OWNER, stateId: start.stateId, idempotencyKey: key };

  // Hold the first request at its keyed hashes, after it registered its key.
  let held = false;
  /** @type {(value?: unknown) => void} */
  let reachedHold = () => {};
  const holdReached = new Promise((resolve) => {
    reachedHold = resolve;
  });
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const hmac = w.service._hmac.bind(w.service);
  w.service._hmac = async (...args) => {
    if (!held && w.service._inflight.has(key)) {
      held = true;
      reachedHold();
      await gate;
    }
    return hmac(...args);
  };
  // Know when the duplicate has joined the first request.
  /** @type {(value?: unknown) => void} */
  let joined = () => {};
  const duplicateJoined = new Promise((resolve) => {
    joined = resolve;
  });
  const log = w.service.log.bind(w.service);
  w.service.log = (event, outcome, source) => {
    if (outcome === 'duplicate') joined();
    log(event, outcome, source);
  };
  // Fail the write of the key's record once the duplicate is waiting.
  let armed = false;
  const original = w.store.transact.bind(w.store);
  w.store.transact = (fn) =>
    original((s) => {
      const own = Object.getOwnPropertyDescriptor(s, 'set');
      const set = s.set.bind(s);
      s.set = (k, v) => {
        if (armed && String(k).startsWith('idem:')) {
          armed = false;
          throw new Error('injected write failure');
        }
        set(k, v);
      };
      try {
        return fn(s);
      } finally {
        if (own) Object.defineProperty(s, 'set', own);
        else Reflect.deleteProperty(s, 'set');
      }
    });

  const first = new BrowserSession(w).postChallenge(body);
  let firstRes;
  let secondRes;
  try {
    await within(holdReached, 'the first request was never held');
    const second = new BrowserSession(w).postChallenge(body);
    await within(duplicateJoined, 'the duplicate never joined');
    armed = true;
    release();
    [firstRes, secondRes] = await within(
      Promise.all([first, second]),
      'a request was not answered'
    );
  } finally {
    release();
  }
  assert.equal(firstRes.status, 500, 'the request that threw is closed');
  assert.deepEqual(await firstRes.json(), { error: 'unavailable' });
  assert.equal(secondRes.status, 500, 'the waiting duplicate is answered');
  assert.deepEqual(await secondRes.json(), { error: 'unavailable' });

  // The same key now starts a new request that can sign in.
  const browser = new BrowserSession(w);
  const retry = await within(
    browser.postChallenge(body),
    'the same-key retry was not answered'
  );
  assert.equal(retry.status, 200);
  const created = await retry.json();
  await within(w.service.drain(), 'the mail queue did not drain');
  const verified = await within(
    browser.verify({
      challengeId: created.challengeId,
      code: w.mailer.lastCode(),
      address: OWNER
    }),
    'the verify was not answered'
  );
  assert.equal(verified.status, 200);
  assert.ok((await verified.json()).proof, 'the retry yields a proof');
});

const SERVICE = 'https://salutant.example.test';
/**
 * @param {Awaited<ReturnType<typeof makeWorld>>} w
 * @param {string} path
 * @param {RequestInit['body']} body
 */
const post = (w, path, body, headers = {}) =>
  w.worker.fetch(
    new Request(`${SERVICE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body })
    })
  );

void test('a JSON null body or a missing body closes create and verify and does not block a same-key retry', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  for (const [key, body] of [
    ['null-body', 'null'],
    ['no-body', undefined]
  ]) {
    const create = await within(
      post(w, '/v1/challenges', body, { 'idempotency-key': key }),
      `${key}: the keyed create was never answered`
    );
    assert.equal(create.status, 500, `${key}: create is closed`);
    assert.deepEqual(await create.json(), { error: 'unavailable' });
    const retry = await within(
      new BrowserSession(w).postChallenge({
        address: OWNER,
        stateId: start.stateId,
        idempotencyKey: key
      }),
      `${key}: the same-key retry was never answered`
    );
    assert.equal(retry.status, 200, `${key}: and it is a normal first answer`);
    await within(w.service.drain(), `${key}: the mail queue did not drain`);
    const verify = await post(w, '/v1/challenges/x/verify', body);
    assert.equal(verify.status, 500, `${key}: verify is closed`);
    assert.deepEqual(await verify.json(), { error: 'unavailable' });
  }
});

void test('JSON primitive and array bodies behave like an empty object', async () => {
  const w = await makeWorld();
  const empty = await post(w, '/v1/challenges', '{}');
  const emptyVerify = await post(w, '/v1/challenges/x/verify', '{}');
  for (const body of ['5', '"text"', 'true', '[]']) {
    const create = await post(w, '/v1/challenges', body);
    assert.equal(create.status, empty.status);
    assert.deepEqual(await create.json(), await empty.clone().json());
    const verify = await post(w, '/v1/challenges/x/verify', body);
    assert.equal(verify.status, emptyVerify.status);
    assert.deepEqual(await verify.json(), await emptyVerify.clone().json());
  }
});
