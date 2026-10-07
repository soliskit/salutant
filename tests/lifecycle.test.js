// R1 code lifecycle and R2 code generation and binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, honestSignIn, OWNER, STRANGER } from './helpers.js';

test('a correct, unexpired, unused code succeeds exactly once', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  assert.equal(r.verify.status, 200);
  assert.ok(r.verified.proof, 'proof issued');
  // Any later use fails (replayed code).
  const again = await r.browser.verify({ challengeId: r.created.challengeId, code: r.code, address: OWNER });
  assert.deepEqual(await again.json(), { error: 'invalid_or_expired_code' });
});

test('a wrong code gives one generic error and counts a try', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  const wrong = await browser.verify({ challengeId: created.challengeId, code: '000000', address: OWNER });
  assert.deepEqual(await wrong.json(), { error: 'invalid_or_expired_code' });
  const c = w.store.transact((s) => s.get(`challenge:${created.challengeId}`));
  assert.equal(c.attempts, 1);
});

test('an expired code fails', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const code = w.mailer.lastCode();
  w.advance(10 * 60_000 + 1);
  const res = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.deepEqual(await res.json(), { error: 'invalid_or_expired_code' });
});

test('five wrong tries end the challenge; a correct sixth try fails', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const code = w.mailer.lastCode();
  for (let i = 0; i < 5; i++) {
    await browser.verify({ challengeId: created.challengeId, code: '000000', address: OWNER });
  }
  const sixth = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.deepEqual(await sixth.json(), { error: 'invalid_or_expired_code' });
});

test('many simultaneous submits of one correct code give exactly one success', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const code = w.mailer.lastCode();
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    browser.verify({ challengeId: created.challengeId, code, address: OWNER }).then((r) => r.json())));
  const proofs = results.filter((r) => r.proof);
  assert.equal(proofs.length, 1, `expected exactly one success, got ${proofs.length}`);
});

test('a resend gives the challenge a new code and kills only its earlier code', async () => {
  const w = await makeWorld();
  const browserA = new BrowserSession(w);
  const browserB = new BrowserSession(w);
  const startA = await w.app.startSignIn(null);
  const startB = await w.app.startSignIn(null);
  const a = await (await browserA.postChallenge({ address: OWNER, stateId: startA.stateId })).json();
  const b = await (await browserB.postChallenge({ address: OWNER, stateId: startB.stateId })).json();
  await w.service.drain();
  const firstCode = w.mailer.outbox.find((m) => m.requestId === a.requestId)?.text.match(/\d{6}/)[0];
  w.advance(61_000); // past the resend cooldown
  await browserA.resend({ challengeId: a.challengeId, address: OWNER });
  await w.service.drain();
  const newCode = w.mailer.outbox.at(-1).text.match(/\d{6}/)[0];
  assert.notEqual(newCode, firstCode);
  // The old code of the resent challenge is dead.
  const oldTry = await browserA.verify({ challengeId: a.challengeId, code: firstCode, address: OWNER });
  assert.deepEqual(await oldTry.json(), { error: 'invalid_or_expired_code' });
  // The other challenge is untouched: its code still works.
  const bCode = w.mailer.outbox.find((m) => m.requestId === b.requestId)?.text.match(/\d{6}/)[0];
  const bTry = await browserB.verify({ challengeId: b.challengeId, code: bCode, address: OWNER });
  assert.ok((await bTry.json()).proof, 'separate challenge coexists');
});

test('a resend before the cooldown is refused', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  const res = await browser.resend({ challengeId: created.challengeId, address: OWNER });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'cooldown' });
});

test('codes bind to their challenge: a code from one fails on another', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const s1 = await w.app.startSignIn(null);
  const s2 = await w.app.startSignIn(null);
  const c1 = await (await browser.postChallenge({ address: OWNER, stateId: s1.stateId })).json();
  const c2 = await (await browser.postChallenge({ address: OWNER, stateId: s2.stateId })).json();
  await w.service.drain();
  const code1 = w.mailer.outbox.find((m) => m.requestId === c1.requestId).text.match(/\d{6}/)[0];
  const cross = await browser.verify({ challengeId: c2.challengeId, code: code1, address: OWNER });
  assert.deepEqual(await cross.json(), { error: 'invalid_or_expired_code' });
});

test('codes bind to the browser: verify without the binding cookie fails', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  const code = w.mailer.lastCode();
  const noCookie = await browser.verify({ challengeId: created.challengeId, code, address: OWNER, omitCookies: true });
  assert.deepEqual(await noCookie.json(), { error: 'invalid_or_expired_code' });
  // Same browser with the cookie still succeeds afterwards.
  const ok = await browser.verify({ challengeId: created.challengeId, code, address: OWNER });
  assert.ok((await ok.json()).proof);
});

test('at most two active challenges per address; a third is refused with the same message and sends no mail', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const s1 = await w.app.startSignIn(null);
  const s2 = await w.app.startSignIn(null);
  const s3 = await w.app.startSignIn(null);
  const r1 = await (await browser.postChallenge({ address: OWNER, stateId: s1.stateId })).json();
  const r2 = await (await browser.postChallenge({ address: OWNER, stateId: s2.stateId })).json();
  const r3 = await (await browser.postChallenge({ address: OWNER, stateId: s3.stateId })).json();
  await w.service.drain();
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  assert.equal(r3.status, 'ok', 'refusal is indistinguishable');
  assert.equal(w.mailer.outbox.length, 2, 'the refused request sent no mail');
});

test('no plain code or address is stored; purge removes expired challenges', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  const dump = JSON.stringify([...w.store.records]);
  assert.ok(!dump.includes(r.code), 'no plain code in storage');
  assert.ok(!dump.includes(OWNER), 'no plain address in storage');
  w.advance(10 * 60_000 + 24 * 3_600_000 + 1);
  w.service.purge();
  assert.equal(w.store.keysWithPrefix('challenge:').length, 0);
});

test('an unlisted address gets the same response shape and no mail', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const res = await browser.postChallenge({ address: STRANGER, stateId: start.stateId });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 0, 'no mail quota used');
});
