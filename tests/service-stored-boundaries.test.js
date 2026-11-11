import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeWorld,
  BrowserSession,
  OWNER,
  SERVICE_ORIGIN,
  APP_ORIGIN
} from './helpers.js';

function create(w, key = null) {
  return w.service.fetch(
    new Request(`${SERVICE_ORIGIN}/v1/challenges`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {})
      },
      body: JSON.stringify({
        address: OWNER,
        appOrigin: APP_ORIGIN,
        stateId: 'boundary-state-0001'
      })
    })
  );
}

async function createdWorld() {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const response = await browser.postChallenge({
    address: OWNER,
    stateId: start.stateId
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  await w.service.drain();
  return { w, browser, created };
}

test('stored replay bodies keep JSON and injected-scalar response conversion with undefined status defaults', async () => {
  for (const [body, text] of [
    [null, ''],
    [undefined, ''],
    ['text', 'text'],
    [7, '7'],
    [true, 'true'],
    [7n, '7'],
    [{ kept: true }, '{"kept":true}'],
    [[1], '[1]']
  ]) {
    const w = await makeWorld();
    const original = w.store.get.bind(w.store);
    // The injected-store seam keeps JSON and cloneability separate.
    // BigInt is cloneable; function/symbol cases below are not.
    w.store.get = (key) =>
      key === 'idem:boundary'
        ? { status: undefined, body, setCookie: 7 }
        : original(key);
    const result = await create(w, 'boundary');
    assert.equal(result.status, 200);
    assert.equal(await result.text(), text);
    assert.equal(result.headers.get('set-cookie'), '7');
    assert.equal(w.mailer.attempts.length, 0);
  }
});

test('injected replay function and symbol bodies fail at response use without sending mail [R5]', async () => {
  for (const body of [() => {}, Symbol('body')]) {
    const w = await makeWorld();
    w.store.get = () => ({ status: 200, body, setCookie: null });
    const response = await create(w, 'boundary');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    assert.equal(w.mailer.attempts.length, 0);
  }
});

test('malformed additive operands close counter requests and stop purge at use; JSON scalar addition is retained', async () => {
  for (const [value, expected] of [
    [{}, 'reject'],
    [[], 'reject'],
    ['1', '11'],
    [null, 1],
    [true, 2],
    [undefined, NaN]
  ]) {
    const { w } = await createdWorld();
    const key = w.store.keysWithPrefix('counter:reqsrc:')[0];
    const record = w.store.getRef(key);
    record.count = value;
    const oldChallenges = w.store.keysWithPrefix('challenge:').length;
    const response = await create(w);
    if (expected === 'reject') {
      assert.equal(response.status, 500);
      assert.equal(record.count, value, 'failure did not replace the operand');
      assert.equal(w.store.keysWithPrefix('challenge:').length, oldChallenges);
    } else {
      assert.equal(response.status, value === '1' ? 429 : 200);
      assert.equal(
        record.count,
        expected,
        'the original raw addition result is stored'
      );
    }
  }
  // MemoryStore does not roll back earlier synchronous mutations on throw.
  // This pins housekeeping order, not a request-failure security guarantee.
  for (const [prefix, field] of [
    ['challenge', 'expiresAtMs'],
    ['reservation', 'createdAtMs'],
    ['issuance', 'expiresAtMs'],
    ['idem', 'createdAtMs']
  ]) {
    for (const operand of [{}, []]) {
      const w = await makeWorld();
      const bad = { [field]: operand };
      w.store.set(`${prefix}:before`, { [field]: 0 });
      w.store.set(`${prefix}:bad`, bad);
      w.store.set(`${prefix}:after`, { [field]: 0 });
      assert.throws(() => w.service.purge(w.getNow()), TypeError);
      assert.equal(
        w.store.get(`${prefix}:before`),
        undefined,
        'earlier deletion remains in the local store'
      );
      assert.equal(
        w.store.getRef(`${prefix}:bad`),
        bad,
        'failed addition leaves the raw record'
      );
      assert.equal(bad[field], operand, 'failed addition leaves the operand');
      assert.deepEqual(
        w.store.get(`${prefix}:after`),
        { [field]: 0 },
        'later record was not reached'
      );
      assert.equal(w.mailer.attempts.length, 0);
    }
  }
});

test('nullish challenge members fail at their first read and a primitive reservation fails after the adapter call [R5]', async () => {
  for (const value of [null, undefined]) {
    const w = await makeWorld();
    w.store.set('challenge:malformed', value);
    const response = await create(w);
    assert.equal(response.status, 500);
    assert.equal(w.mailer.attempts.length, 0);
  }
  const w = await makeWorld();
  w.store.set('reservation:primitive', true);
  await assert.rejects(
    w.service._sendCode('primitive', OWNER, '123456'),
    TypeError
  );
  assert.equal(
    w.mailer.attempts.length,
    1,
    'the original send-before-record-write order remains'
  );
  assert.equal(w.store.get('reservation:primitive'), true);
});

test('stored non-string code and binding HMACs fail at decoder use before consumption [R5]', async () => {
  for (const field of ['codeHmac', 'bindingHmac']) {
    const { w, browser, created } = await createdWorld();
    const record = w.store.getRef(`challenge:${created.challengeId}`);
    record[field] = 7;
    const response = await browser.verify({
      challengeId: created.challengeId,
      code: w.mailer.lastCode(),
      address: OWNER
    });
    assert.equal(response.status, 500);
    assert.equal(record.state, 'open');
    assert.deepEqual(w.store.keysWithPrefix('issuance:'), []);
  }
  for (const appOrigin of [null, undefined]) {
    const { w, browser, created } = await createdWorld();
    const record = w.store.getRef(`challenge:${created.challengeId}`);
    record.appOrigin = appOrigin;
    const response = await browser.verify({
      challengeId: created.challengeId,
      code: w.mailer.lastCode(),
      address: OWNER
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      error: 'invalid_or_expired_code'
    });
    assert.equal(record.state, 'open');
    assert.equal(record.attempts, 1);
    assert.deepEqual(w.store.keysWithPrefix('issuance:'), []);
  }
});

test('rolling timestamp reads keep nullish defaults and raw retained values, but reject a non-array at filter use', async () => {
  for (const shape of [
    'null-record',
    'undefined-record',
    'null-timestamps',
    'undefined-timestamps',
    'null-count',
    'undefined-count',
    'values',
    'bad'
  ]) {
    const { w } = await createdWorld();
    const key = w.store.keysWithPrefix('counter:sendaddr:')[0];
    const now = w.getNow();
    const value =
      shape === 'null-record'
        ? null
        : shape === 'undefined-record'
          ? undefined
          : {
              timestamps:
                shape === 'null-timestamps' ||
                shape === 'null-count' ||
                shape === 'undefined-count'
                  ? null
                  : shape === 'undefined-timestamps'
                    ? undefined
                    : shape === 'values'
                      ? [String(now), now - 1_800_001, null, true, []]
                      : 'bad',
              expiresAtMs: now + 100_000
            };
    w.store.set(key, value);
    if (shape === 'null-record') {
      for (const dailyKey of w.store.keysWithPrefix('counter:sendday:'))
        w.store.set(dailyKey, null);
    }
    if (shape === 'null-count' || shape === 'undefined-count') {
      for (const dailyKey of w.store.keysWithPrefix('counter:sendday:')) {
        const counter = w.store.getRef(dailyKey);
        counter.count = shape === 'null-count' ? null : undefined;
      }
    }
    const response = await create(w);
    assert.equal(response.status, shape === 'bad' ? 500 : 200);
    if (shape !== 'bad') {
      await w.service.drain();
      if (shape === 'null-count' || shape === 'undefined-count') {
        for (const dailyKey of w.store.keysWithPrefix('counter:sendday:'))
          assert.equal(
            w.store.get(dailyKey).count,
            shape === 'null-count' ? 1 : NaN
          );
      }
      assert.deepEqual(
        w.store.get(key).timestamps,
        shape === 'values' ? [String(now), now] : [now]
      );
    }
  }
});

test('apps remain unchecked until the original route use; some skips sparse slots and nullish members still fail', async () => {
  for (const apps of [null, {}, 'bad']) {
    const w = await makeWorld();
    w.service.apps = apps;
    assert.equal(
      (await w.worker.fetch(new Request(`${SERVICE_ORIGIN}/app.js`))).status,
      200
    );
    assert.equal((await create(w)).status, 500);
    await assert.rejects(
      w.worker.fetch(
        new Request(`${SERVICE_ORIGIN}/?app=${encodeURIComponent(APP_ORIGIN)}`)
      ),
      TypeError
    );
  }
  for (const app of [null, undefined]) {
    const w = await makeWorld();
    w.service.apps = [app];
    await assert.rejects(
      w.worker.fetch(
        new Request(`${SERVICE_ORIGIN}/?app=${encodeURIComponent(APP_ORIGIN)}`)
      ),
      TypeError
    );
  }
  const w = await makeWorld();
  w.service.apps = [true];
  assert.equal(
    (
      await w.worker.fetch(
        new Request(`${SERVICE_ORIGIN}/?app=${encodeURIComponent(APP_ORIGIN)}`)
      )
    ).status,
    400
  );
  w.service.apps = new Array(1);
  assert.equal(
    (
      await w.worker.fetch(
        new Request(`${SERVICE_ORIGIN}/?app=${encodeURIComponent(APP_ORIGIN)}`)
      )
    ).status,
    400
  );
});

test('a missing current signing key fails at proof signing after consumption without recording issuance [R5]', async () => {
  const { w, browser, created } = await createdWorld();
  w.service.signingKeys.delete(w.service.currentKid);
  const response = await browser.verify({
    challengeId: created.challengeId,
    code: w.mailer.lastCode(),
    address: OWNER
  });
  assert.equal(response.status, 500);
  assert.equal(
    w.store.get(`challenge:${created.challengeId}`).state,
    'consumed'
  );
  assert.deepEqual(w.store.keysWithPrefix('issuance:'), []);
});
