// R1 code lifecycle and R2 code generation and binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeWorld,
  makeDOStorage,
  BrowserSession,
  honestSignIn,
  OWNER,
  STRANGER,
  readCreated
} from './helpers.js';
import { DurableObjectStore } from '../src/do-store.js';

void test('a correct, unexpired, unused code succeeds exactly once', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.equal(r.verify.status, 200);
  assert.ok(r.verified.proof, 'proof issued');
  // Any later use fails (replayed code).
  const again = await r.browser.verify({
    challengeId: r.created.challengeId,
    code: r.code,
    address: OWNER
  });
  assert.deepEqual(await again.json(), { error: 'invalid_or_expired_code' });
});

void test('a wrong code gives one generic error and counts a try', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  const wrong = await browser.verify({
    challengeId: created.challengeId,
    code: '000000',
    address: OWNER
  });
  assert.deepEqual(await wrong.json(), { error: 'invalid_or_expired_code' });
  const c = w.store.transact((s) => s.get(`challenge:${created.challengeId}`));
  assert.equal(c.attempts, 1);
});

void test('an expired code fails', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  const code = w.mailer.lastCode();
  w.advance(30 * 60_000 + 1);
  const res = await browser.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER
  });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
});

void test('three wrong tries end the challenge; a correct fourth try fails', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  const code = w.mailer.lastCode();
  const wrongCode = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 3; i++) {
    const wrong = await browser.verify({
      challengeId: created.challengeId,
      code: wrongCode,
      address: OWNER
    });
    assert.deepEqual(
      await wrong.json(),
      { error: 'invalid_or_expired_code' },
      `wrong try ${String(i + 1)} must fail`
    );
  }
  const fourth = await browser.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER
  });
  assert.deepEqual(await fourth.json(), { error: 'invalid_or_expired_code' });
});

void test('a correct third try still succeeds after two wrong tries', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  const code = w.mailer.lastCode();
  const wrongCode = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 2; i++) {
    const wrong = await browser.verify({
      challengeId: created.challengeId,
      code: wrongCode,
      address: OWNER
    });
    assert.deepEqual(
      await wrong.json(),
      { error: 'invalid_or_expired_code' },
      `wrong try ${String(i + 1)} must fail`
    );
  }
  const third = await browser.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER
  });
  const body = await third.json();
  assert.ok(body.proof, 'the correct code on the third try must issue a proof');
});

void test('many simultaneous submits of one correct code give exactly one success', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  const code = w.mailer.lastCode();
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      browser
        .verify({ challengeId: created.challengeId, code, address: OWNER })
        .then((r) => r.json())
    )
  );
  const proofs = results.filter((r) => r.proof);
  assert.equal(
    proofs.length,
    1,
    `expected exactly one success, got ${String(proofs.length)}`
  );
});

void test('a resend gives the challenge a new code and kills only its earlier code', async () => {
  const w = await makeWorld();
  const browserA = new BrowserSession(w);
  const browserB = new BrowserSession(w);
  const startA = await w.app.startSignIn(null);
  const startB = await w.app.startSignIn(null);
  const a = await (
    await browserA.postChallenge({ address: OWNER, stateId: startA.stateId })
  ).json();
  const b = await (
    await browserB.postChallenge({ address: OWNER, stateId: startB.stateId })
  ).json();
  await w.service.drain();
  const firstCode = w.mailer.outbox
    .find((m) => m.requestId === a.requestId)
    ?.text.match(/\d{6}/)[0];
  w.advance(61_000); // past the resend cooldown
  await browserA.resend({ challengeId: a.challengeId, address: OWNER });
  await w.service.drain();
  const newCode = w.mailer.outbox.at(-1).text.match(/\d{6}/)[0];
  assert.notEqual(newCode, firstCode);
  // The old code of the resent challenge is dead.
  const oldTry = await browserA.verify({
    challengeId: a.challengeId,
    code: firstCode,
    address: OWNER
  });
  assert.deepEqual(await oldTry.json(), { error: 'invalid_or_expired_code' });
  // The other challenge is untouched: its code still works.
  const bCode = w.mailer.outbox
    .find((m) => m.requestId === b.requestId)
    ?.text.match(/\d{6}/)[0];
  const bTry = await browserB.verify({
    challengeId: b.challengeId,
    code: bCode,
    address: OWNER
  });
  assert.ok((await bTry.json()).proof, 'separate challenge coexists');
});

void test('a resend before the cooldown is refused', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  const res = await browser.resend({
    challengeId: created.challengeId,
    address: OWNER
  });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'cooldown' });
});

void test('codes bind to their challenge: a code from one fails on another', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const s1 = await w.app.startSignIn(null);
  const s2 = await w.app.startSignIn(null);
  const c1 = await (
    await browser.postChallenge({ address: OWNER, stateId: s1.stateId })
  ).json();
  const c2 = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: s2.stateId })
  );
  await w.service.drain();
  const code1 = w.mailer.outbox
    .find((m) => m.requestId === c1.requestId)
    .text.match(/\d{6}/)[0];
  const cross = await browser.verify({
    challengeId: c2.challengeId,
    code: code1,
    address: OWNER
  });
  assert.deepEqual(await cross.json(), { error: 'invalid_or_expired_code' });
});

void test('codes bind to the browser: verify without the binding cookie fails', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  const code = w.mailer.lastCode();
  const noCookie = await browser.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER,
    omitCookies: true
  });
  assert.deepEqual(await noCookie.json(), { error: 'invalid_or_expired_code' });
  // Same browser with the cookie still succeeds afterwards.
  const ok = await browser.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER
  });
  assert.ok((await ok.json()).proof);
});

void test('at most two active challenges per address; a third is refused with the same message and sends no mail', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const s1 = await w.app.startSignIn(null);
  const s2 = await w.app.startSignIn(null);
  const s3 = await w.app.startSignIn(null);
  const r1 = await (
    await browser.postChallenge({ address: OWNER, stateId: s1.stateId })
  ).json();
  const r2 = await (
    await browser.postChallenge({ address: OWNER, stateId: s2.stateId })
  ).json();
  const r3 = await (
    await browser.postChallenge({ address: OWNER, stateId: s3.stateId })
  ).json();
  await w.service.drain();
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  assert.equal(r3.status, 'ok', 'refusal is indistinguishable');
  assert.equal(w.mailer.outbox.length, 2, 'the refused request sent no mail');
});

void test('no plain code or address is stored; purge removes expired challenges', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  const dump = JSON.stringify([...w.store.records]);
  assert.ok(!dump.includes(String(r.code)), 'no plain code in storage');
  assert.ok(!dump.includes(OWNER), 'no plain address in storage');
  w.advance(30 * 60_000 + 3_600_000 + 1); // expiry plus the one-hour purge lag
  w.service.purge();
  assert.equal(w.store.keysWithPrefix('challenge:').length, 0);
});

void test('idempotency records are purged with the address-state window', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  await browser.postChallenge({
    address: OWNER,
    stateId: start.stateId,
    idempotencyKey: 'purge-me'
  });
  assert.equal(w.store.keysWithPrefix('idem:').length, 1);
  w.advance(24 * 3_600_000 + 1);
  w.service.purge();
  assert.equal(w.store.keysWithPrefix('idem:').length, 0);
});

void test('an unlisted address gets the same response shape and no mail', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const res = await browser.postChallenge({
    address: STRANGER,
    stateId: start.stateId
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 0, 'no mail quota used');
});

void test('a request body that is not valid JSON is refused and sends nothing [R6]', async () => {
  const w = await makeWorld();
  const create = await w.worker.fetch(
    new Request('https://salutant.example.test/v1/challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    })
  );
  assert.equal(create.status, 400);
  assert.deepEqual(await create.json(), { error: 'bad_request' });
  const verify = await w.worker.fetch(
    new Request('https://salutant.example.test/v1/challenges/abc/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    })
  );
  assert.equal(verify.status, 400);
  await w.service.drain();
  assert.equal(w.mailer.attempts.length, 0);
});

void test('a resend that cannot be honored answers like one that can, and sends nothing extra [R3]', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  w.advance(61_000);
  const honest = await browser.resend({
    challengeId: created.challengeId,
    address: OWNER
  });
  await w.service.drain();
  const sent = w.mailer.attempts.length;
  assert.equal(sent, 2, 'the honest resend is the only extra send');
  const shape = async (res) => ({
    status: res.status,
    keys: Object.keys(await res.json()).sort()
  });
  const expected = await shape(honest);
  assert.deepEqual(expected, {
    status: 200,
    keys: ['challengeId', 'requestId', 'status']
  });
  w.advance(61_000);
  const unknownChallenge = await browser.resend({
    challengeId: 'no-such-challenge',
    address: OWNER
  });
  const noAddress = await browser.resend({
    challengeId: created.challengeId,
    address: ''
  });
  const wrongAddress = await browser.resend({
    challengeId: created.challengeId,
    address: STRANGER
  });
  for (const res of [unknownChallenge, noAddress, wrongAddress])
    assert.deepEqual(await shape(res), expected);
  // Once the challenge is used up, a resend for it also looks the same and sends nothing.
  const code = w.mailer.lastCode();
  const used = await browser.verify({
    challengeId: created.challengeId,
    code,
    address: OWNER
  });
  assert.ok((await used.json()).proof);
  w.advance(61_000);
  const afterUse = await browser.resend({
    challengeId: created.challengeId,
    address: OWNER
  });
  assert.deepEqual(await shape(afterUse), expected);
  await w.service.drain();
  assert.equal(
    w.mailer.attempts.length,
    sent,
    'none of the refused resends sent mail'
  );
});

// R2: a resend and a verify of the old code at the same moment. The old and
// new code of one challenge must never both succeed.
void test('a resend racing a verify of the old code never leaves both codes working', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await readCreated(
    await browser.postChallenge({ address: OWNER, stateId: start.stateId })
  );
  await w.service.drain();
  const oldCode = w.mailer.lastCode();
  const sentBefore = w.mailer.outbox.length;
  w.advance(61_000); // past the resend cooldown
  const [, oldTry] = await Promise.all([
    browser.resend({ challengeId: created.challengeId, address: OWNER }),
    browser.verify({
      challengeId: created.challengeId,
      code: oldCode,
      address: OWNER
    })
  ]);
  await w.service.drain();
  const oldWorked = Boolean((await oldTry.json()).proof);
  let newWorked = false;
  if (w.mailer.outbox.length > sentBefore) {
    const newCode = w.mailer.lastCode();
    assert.notEqual(newCode, oldCode);
    const newTry = await browser.verify({
      challengeId: created.challengeId,
      code: newCode,
      address: OWNER
    });
    newWorked = Boolean((await newTry.json()).proof);
  }
  assert.ok(
    !(oldWorked && newWorked),
    'the old and new code do not both succeed'
  );
});

const HOUR = 3_600_000;

/** @param {Parameters<typeof makeWorld>[0]} [worldOptions] */
async function seededForPurge(worldOptions) {
  const w = await makeWorld(worldOptions);
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const t0 = w.getNow();
  const create = await browser.postChallenge({
    address: OWNER,
    stateId: start.stateId,
    idempotencyKey: 'purge-boundary'
  });
  const created = await readCreated(create);
  await w.service.drain();
  w.advance(1000);
  const tv = w.getNow();
  const verify = await browser.verify({
    challengeId: created.challengeId,
    code: w.mailer.lastCode(),
    address: OWNER
  });
  assert.ok((await verify.json()).proof, 'proof issued');
  return { w, t0, tv };
}

/** @type {Array<[string, (t: Awaited<ReturnType<typeof seededForPurge>>) => number]>} */
const PURGE_DEADLINES = [
  ['challenge:', (t) => t.t0 + 30 * 60_000 + HOUR],
  ['issuance:', (t) => t.tv + 300_000 + HOUR],
  ['reservation:', (t) => t.t0 + 24 * HOUR],
  ['idem:', (t) => t.t0 + 24 * HOUR],
  ['counter:reqaddr:', (t) => t.t0 + 24 * HOUR]
];

for (const [prefix, deadlineOf] of PURGE_DEADLINES) {
  void test(`purge keeps ${prefix} records until their configured purge time and removes them at it`, async () => {
    const t = await seededForPurge();
    const deadline = deadlineOf(t);
    /** @param {string} p */
    const count = (p) => t.w.store.keysWithPrefix(p).length;
    /** @type {Array<[string, number, number]>} */
    const others = PURGE_DEADLINES.filter(([p]) => p !== prefix).map(
      ([p, d]) => [p, d(t), count(p)]
    );
    const before = count(prefix);
    assert.equal(before, 1, 'one record to purge');
    t.w.service.purge(deadline - 1);
    assert.equal(
      count(prefix),
      before,
      'kept one millisecond before the purge time'
    );
    t.w.service.purge(deadline);
    assert.equal(count(prefix), 0, 'removed at the purge time');
    for (const [p, d, n] of others) {
      if (d > deadline)
        assert.equal(count(p), n, `${p} untouched before its own purge time`);
    }
  });
}

const PURGE_FAMILIES = PURGE_DEADLINES.map(([p]) => p);

// Purge reads records to decide; reading must not write. The stand-in is
// a real SQLite engine behind the store, so its non-SELECT statement
// count is the witness: zero counted writes while nothing is due, and
// only the due deletions once a family passes its purge time.
void test('purge writes nothing while every record is kept', async () => {
  const storage = makeDOStorage();
  const t = await seededForPurge({
    storeFactory: () => new DurableObjectStore(storage)
  });
  const kept = new Map();
  for (const p of PURGE_FAMILIES)
    for (const k of t.w.store.keysWithPrefix(p)) kept.set(k, t.w.store.get(k));
  assert.ok(kept.size > 0, 'seeded records to keep');
  storage.writes = 0;
  t.w.service.purge(t.w.getNow());
  assert.equal(storage.writes, 0, 'a kept record is never rewritten');
  for (const [k, v] of kept)
    assert.deepEqual(t.w.store.get(k), v, `${k} is unchanged`);
});

void test('purge deletes only the due records and writes nothing else', async () => {
  const storage = makeDOStorage();
  const t = await seededForPurge({
    storeFactory: () => new DurableObjectStore(storage)
  });
  const deadline = PURGE_DEADLINES.find(([p]) => p === 'challenge:')[1](t);
  const before = new Map();
  for (const p of PURGE_FAMILIES)
    for (const k of t.w.store.keysWithPrefix(p))
      before.set(k, t.w.store.get(k));
  storage.writes = 0;
  t.w.service.purge(deadline);
  const kept = new Map();
  for (const p of PURGE_FAMILIES)
    for (const k of t.w.store.keysWithPrefix(p)) kept.set(k, t.w.store.get(k));
  assert.ok(kept.size < before.size, 'due records are removed');
  assert.equal(
    storage.writes,
    before.size - kept.size,
    'only the deletions write; kept records are not rewritten'
  );
  for (const [k, v] of kept)
    assert.deepEqual(v, before.get(k), `${k} is unchanged`);
});
