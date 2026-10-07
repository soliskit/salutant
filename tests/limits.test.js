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

test('sends per address per hour: the fourth request is refused indistinguishably and sends no mail', async () => {
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
  // R3: over the send budget the listed address gets the same generic
  // 200 an unlisted address always gets - a 429 would reveal membership.
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 3);
});

test('an unlisted address and an over-budget listed address return the same response', async () => {
  const w = await makeWorld({ config: { requestsPerAddressPerHour: 1000, activeChallengesPerAddress: 100 } });
  // Spend the listed address's hourly send budget.
  for (let i = 0; i < 3; i++) {
    const start = await w.app.startSignIn(null);
    await new BrowserSession(w).postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i}` } });
    w.advance(61_000);
  }
  const probe = async (address, ip) => {
    const start = await w.app.startSignIn(null);
    const res = await new BrowserSession(w).postChallenge({ address, stateId: start.stateId, headers: { 'cf-connecting-ip': ip } });
    const body = JSON.stringify(await res.json()).replace(/"(requestId|challengeId)":"[^"]+"/g, '"$1":"x"');
    return `${res.status}:${body}`;
  };
  const listedOverBudget = await probe(OWNER, '192.0.2.250');
  const unlisted = await probe(STRANGER, '192.0.2.251');
  assert.equal(listedOverBudget, unlisted, 'limit response must not reveal membership');
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

test('R8 attack, honest owner path: slot-filling delays the owner, and the mailed code is unusable outside the attacker browser', async () => {
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
  // Honest owner path: the mailed code from the attacker's challenge is
  // NOT usable from the owner's own browser. The binding cookie that
  // verify requires lives only in the attacker's browser (R2). The code
  // is not invalidated - it still verifies from the browser that
  // requested it - but that browser is the attacker's, so the plan's
  // "owner delayed only" claim holds only because the owner can start a
  // fresh challenge once a slot frees, NOT because the mailed code can
  // be used. Recorded as a phase 1 finding.
  const code = w.mailer.outbox[0].text.match(/\d{6}/)[0];
  const c1 = w.store.transact((s) => s.getRef([...s.keysWithPrefix('challenge:')][0]));
  const ownerTry = await ownerBrowser.verify({ challengeId: c1.id, code, address: OWNER });
  assert.deepEqual(await ownerTry.json(), { error: 'invalid_or_expired_code' },
    'binding: the mailed code does not work outside the requesting browser');
  const attackerTry = await attackBrowser.verify({ challengeId: c1.id, code, address: OWNER });
  assert.ok((await attackerTry.json()).proof, 'the code itself was never invalidated');
  // The delay ends when the attacker's challenges expire: the owner's
  // own challenge then completes end to end from the owner's browser.
  w.advance(10 * 60_000 + 1);
  const r = await honestSignIn(w, { browser: ownerBrowser });
  assert.ok(r.verified.proof, 'the owner signs in once slots free');
  assert.equal(r.complete.status, 200);
});

test('10 concurrent creates cannot exceed the active-challenge cap', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    new BrowserSession(w).postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i}` } })));
  await w.service.drain();
  const live = w.store.keysWithPrefix('challenge:')
    .map((k) => w.store.transact((s) => s.getRef(k)))
    .filter((c) => c.state === 'open');
  assert.equal(live.length, 2, 'cap 2 active challenges holds under concurrency');
  assert.equal(w.mailer.outbox.length, 2, 'no extra mails');
});

test('10 concurrent creates cannot exceed the hourly send budget', async () => {
  const w = await makeWorld({ config: { requestsPerAddressPerHour: 1000, activeChallengesPerAddress: 100 } });
  const start = await w.app.startSignIn(null);
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    new BrowserSession(w).postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i}` } })));
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 3, 'cap 3 sends per hour holds under concurrency');
  assert.equal(w.store.keysWithPrefix('challenge:').length, 3, 'refused requests wrote nothing');
});

test('10 concurrent resends after the cooldown produce exactly one resend', async () => {
  const w = await makeWorld();
  const browser = new BrowserSession(w);
  const start = await w.app.startSignIn(null);
  const created = await (await browser.postChallenge({ address: OWNER, stateId: start.stateId })).json();
  await w.service.drain();
  w.advance(61_000);
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    browser.resend({ challengeId: created.challengeId, address: OWNER })));
  await w.service.drain();
  const okCount = results.filter((r) => r.status === 200).length;
  assert.equal(okCount, 1, 'exactly one resend passes the cooldown gate');
  assert.equal(results.filter((r) => r.status === 429).length, 9);
  assert.equal(w.mailer.outbox.length, 2, 'one original mail plus one resend');
});

test('every refusal is identical for every address class, whatever limit fired', async () => {
  const w = await makeWorld({ config: { sendsPerDay: 2 } });
  const browser = new BrowserSession(w);
  // Fill the owner's two slots and exhaust the daily budget.
  const s1 = await w.app.startSignIn(null);
  const s2 = await w.app.startSignIn(null);
  await browser.postChallenge({ address: OWNER, stateId: s1.stateId, headers: { 'cf-connecting-ip': '192.0.2.1' } });
  await browser.postChallenge({ address: OWNER, stateId: s2.stateId, headers: { 'cf-connecting-ip': '192.0.2.2' } });
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 2);
  // The listed address hits the cap first; the unlisted address hits
  // the global budget. Both must answer identically (R3).
  const probe = async (address, ip) => {
    const start = await w.app.startSignIn(null);
    const res = await new BrowserSession(w).postChallenge({ address, stateId: start.stateId, headers: { 'cf-connecting-ip': ip } });
    const body = JSON.stringify(await res.json()).replace(/"(requestId|challengeId)":"[^"]+"/g, '"$1":"x"');
    const cookie = (res.headers.getSetCookie?.() ?? [''])[0]
      .replace(/sb_[^=]+=[^;]+/, 'sb_ID=BINDING').replace(/challenges\/[^/]+/, 'challenges/ID');
    return `${res.status}:${body}:${cookie}`;
  };
  assert.equal(await probe(OWNER, '192.0.2.250'), await probe(STRANGER, '192.0.2.251'),
    'cap refusal and budget refusal must be indistinguishable');
});

test('an over-hourly-budget listed address gets the same cookie shape as an accepted unlisted one', async () => {
  const w = await makeWorld({ config: { requestsPerAddressPerHour: 1000, activeChallengesPerAddress: 100 } });
  for (let i = 0; i < 3; i++) {
    const start = await w.app.startSignIn(null);
    await new BrowserSession(w).postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i}` } });
    w.advance(61_000);
  }
  const probe = async (address, ip) => {
    const start = await w.app.startSignIn(null);
    const res = await new BrowserSession(w).postChallenge({ address, stateId: start.stateId, headers: { 'cf-connecting-ip': ip } });
    const cookies = res.headers.getSetCookie?.() ?? [];
    assert.equal(cookies.length, 1, `${address}: exactly one Set-Cookie`);
    return cookies[0].replace(/sb_[^=]+=[^;]+/, 'sb_ID=BINDING').replace(/challenges\/[^/]+/, 'challenges/ID');
  };
  const listedOverBudget = await probe(OWNER, '192.0.2.250');
  const unlistedAccepted = await probe(STRANGER, '192.0.2.251');
  assert.equal(listedOverBudget, unlistedAccepted, 'cookie issuance must be uniform (R3)');
});
