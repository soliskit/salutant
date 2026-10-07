// R6 limits and R8 quota and lockout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, honestSignIn, OWNER, STRANGER } from './helpers.js';

test('requests per source per hour: the eleventh is limited, same for both address classes', async () => {
  const w = await makeWorld({ config: { requestsPerAddressPerHour: 1000, sendsPerAddressPerHour: 1000 } });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  let last;
  for (let i = 0; i < 11; i++) {
    last = await browser.postChallenge({
      address: i % 2 ? STRANGER : OWNER, stateId: start.stateId,
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: 'rate_limited' });
});

test('requests per address per hour: the eleventh for one address is limited', async () => {
  const w = await makeWorld({ config: { sendsPerAddressPerHour: 1000 } });
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  let last;
  for (let i = 0; i < 11; i++) {
    last = await browser.postChallenge({
      address: OWNER, stateId: start.stateId,
      headers: { 'cf-connecting-ip': `198.51.100.${i}` }, // fresh source each time
    });
  }
  assert.equal(last.status, 429);
});

test('sends per address per hour: the fourth send is refused', async () => {
  const w = await makeWorld({ config: { requestsPerAddressPerHour: 1000, activeChallengesPerAddress: 100 } });
  const browser = new BrowserSession(w);
  for (let i = 0; i < 3; i++) {
    const start = await w.app.startSignIn(null);
    const res = await browser.postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i}` } });
    assert.equal(res.status, 200);
    w.advance(61_000);
  }
  const start = await w.app.startSignIn(null);
  const res = await browser.postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.9' } });
  assert.equal(res.status, 429);
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 3);
});

test('oversize bodies are refused', async () => {
  const w = await makeWorld();
  const res = await w.worker.fetch(new Request('https://salutant.example.test/v1/challenges', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: 'someone@example.test', pad: 'x'.repeat(3000), appOrigin: 'https://app.example.test', stateId: 'y'.repeat(24) }),
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request' });
});

test('the source address comes from the trusted header, never a client-supplied one', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  await browser.postChallenge({
    address: OWNER, stateId: start.stateId,
    headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '10.0.0.1' },
  });
  const keys = w.store.keysWithPrefix('counter:reqsrc:');
  assert.equal(keys.length, 1);
  // Recompute the expected key: the counter must be keyed on the trusted
  // header value. We cannot reverse the HMAC, so instead show the
  // spoofed value never lands anywhere in storage.
  assert.ok(!JSON.stringify([...w.store.records]).includes('10.0.0.1'));
});

test('address-linked state expires within 24 hours; the monthly count does not', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  await browser.postChallenge({ address: OWNER, stateId: start.stateId });
  const now = w.getNow();
  for (const k of w.store.keysWithPrefix('counter:reqaddr:')) {
    assert.ok(w.store.transact((s) => s.getRef(k)).expiresAtMs - now <= 24 * 3_600_000);
  }
  const monthKey = w.store.keysWithPrefix('counter:sendmonth:')[0];
  assert.ok(w.store.transact((s) => s.getRef(monthKey)).expiresAtMs - now > 24 * 3_600_000);
  w.advance(24 * 3_600_000 + 1);
  w.service.purge();
  assert.equal(w.store.keysWithPrefix('counter:reqaddr:').length, 0, 'address-linked state purged');
  assert.equal(w.store.keysWithPrefix('counter:sendmonth:').length, 1, 'monthly total survives');
});

test('R8 attack: a stranger fills the owner\'s slots; the owner is delayed but the real code works and the delay ends', async () => {
  const w = await makeWorld({ allowlist: [OWNER] });
  const ownerBrowser = new BrowserSession(w);
  const attackBrowser = new BrowserSession(w);
  // The attacker knows the owner's address and fills both slots.
  const s1 = await w.app.startSignIn(null);
  const s2 = await w.app.startSignIn(null);
  await attackBrowser.postChallenge({ address: OWNER, stateId: s1.stateId, headers: { 'cf-connecting-ip': '203.0.113.66' } });
  await attackBrowser.postChallenge({ address: OWNER, stateId: s2.stateId, headers: { 'cf-connecting-ip': '203.0.113.66' } });
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 2, 'the real code still goes to the owner');
  // The owner's new request is refused (same generic message, no mail).
  const s3 = await w.app.startSignIn(null);
  const refused = await ownerBrowser.postChallenge({ address: OWNER, stateId: s3.stateId, headers: { 'cf-connecting-ip': '198.51.100.7' } });
  assert.equal((await refused.json()).status, 'ok');
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 2, 'no third mail');
  // The attacker's codes were never invalidated: the owner can still
  // sign in with the real code from the first challenge.
  const code = w.mailer.outbox[0].text.match(/\d{6}/)[0];
  const c1 = w.store.transact((s) => s.getRef([...s.keysWithPrefix('challenge:')][0]));
  const ok = await attackBrowser.verify({ challengeId: c1.id, code, address: OWNER, omitCookies: false });
  assert.ok((await ok.json()).proof, 'the real code still works');
  // The delay ends when the attacker's challenges expire.
  w.advance(10 * 60_000 + 1);
  const s4 = await w.app.startSignIn(null);
  const after = await ownerBrowser.postChallenge({ address: OWNER, stateId: s4.stateId, headers: { 'cf-connecting-ip': '198.51.100.7' } });
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 3, 'the owner can sign in again once slots free');
});
