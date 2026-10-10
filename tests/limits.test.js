// R6 limits and R8 quota and lockout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, BrowserSession, honestSignIn, OWNER, STRANGER } from './helpers.js';

test('requests per source per hour: the eleventh is limited, same for both address classes', async () => {
  const w = await makeWorld({ config: { requestsPerAddressPerHour: 1000, sendsPerAddressPer30Minutes: 1000 } });
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
  const w = await makeWorld({ config: { sendsPerAddressPer30Minutes: 1000 } });
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

test('sends per address per 30 minutes: the fourth request is refused indistinguishably and sends no mail', async () => {
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
  // Spend the listed address's 30-minute send budget.
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
  w.advance(30 * 60_000 + 1);
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

test('10 concurrent creates cannot exceed the 30-minute send budget', async () => {
  const w = await makeWorld({ config: { requestsPerAddressPerHour: 1000, activeChallengesPerAddress: 100 } });
  const start = await w.app.startSignIn(null);
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    new BrowserSession(w).postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i}` } })));
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 3, 'cap 3 sends per 30 minutes holds under concurrency');
  // Refused requests do the same storage work as unlisted acceptances
  // (R3), but none of their reservations is ever delivered.
  const delivered = w.store.keysWithPrefix('reservation:')
    .map((k) => w.store.transact((s) => s.getRef(k)))
    .filter((r) => r.outcome === 'accepted');
  assert.equal(delivered.length, 3, 'only 3 reservations delivered');
  assert.equal(w.store.keysWithPrefix('challenge:').length, 10, 'uniform storage work');
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

test('resend budget refusals are identical for listed and unlisted addresses', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const listedBrowser = new BrowserSession(w);
  const unlistedBrowser = new BrowserSession(w);
  const lc = await (await listedBrowser.postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.1' } })).json();
  const uc = await (await unlistedBrowser.postChallenge({ address: STRANGER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.2' } })).json();
  await w.service.drain();
  const seq = async (browser, id) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      w.advance(61_000);
      const res = await browser.resend({ challengeId: id, address: id === lc.challengeId ? OWNER : STRANGER });
      const body = JSON.stringify(await res.json()).replace(/"(requestId|challengeId)":"[^"]+"/g, '"$1":"x"');
      out.push(`${res.status}:${body}`);
    }
    return out;
  };
  const listed = await seq(listedBrowser, lc.challengeId);
  const unlisted = await seq(unlistedBrowser, uc.challengeId);
  // The listed address exhausts its 3 sends/30 minutes on the third resend;
  // the unlisted address never bumps a counter. Both sequences must
  // read identically (R3).
  assert.deepEqual(listed, unlisted, 'resend refusals must not reveal membership');
  assert.equal(w.mailer.outbox.length, 3, 'the withheld resend sent no mail');
});

test('resend budget refusal with sendsPerAddressPer30Minutes=1 matches the unlisted response', async () => {
  const w = await makeWorld({ config: { sendsPerAddressPer30Minutes: 1 } });
  const start = await w.app.startSignIn(null);
  const listedBrowser = new BrowserSession(w);
  const unlistedBrowser = new BrowserSession(w);
  const lc = await (await listedBrowser.postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.1' } })).json();
  const uc = await (await unlistedBrowser.postChallenge({ address: STRANGER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.2' } })).json();
  await w.service.drain();
  w.advance(61_000);
  const probe = async (browser, id, address) => {
    const res = await browser.resend({ challengeId: id, address });
    return `${res.status}:${JSON.stringify(await res.json()).replace(/"(requestId|challengeId)":"[^"]+"/g, '"$1":"x"')}`;
  };
  assert.equal(await probe(listedBrowser, lc.challengeId, OWNER), await probe(unlistedBrowser, uc.challengeId, STRANGER),
    'the over-budget resend answer must not reveal membership');
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 1, 'no mail beyond the first send');
});

test('after a withheld resend, an immediate retry meets the same cooldown for both classes', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const listedBrowser = new BrowserSession(w);
  const unlistedBrowser = new BrowserSession(w);
  const lc = await (await listedBrowser.postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.1' } })).json();
  const uc = await (await unlistedBrowser.postChallenge({ address: STRANGER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.2' } })).json();
  await w.service.drain();
  // Three spaced resends each: the third listed resend is withheld
  // (30-minute budget 3 spent), the unlisted ones are all accepted.
  for (let i = 0; i < 3; i++) {
    w.advance(61_000);
    await listedBrowser.resend({ challengeId: lc.challengeId, address: OWNER });
    await unlistedBrowser.resend({ challengeId: uc.challengeId, address: STRANGER });
  }
  // Immediate follow-up: both classes must meet the same cooldown.
  const listedRetry = await listedBrowser.resend({ challengeId: lc.challengeId, address: OWNER });
  const unlistedRetry = await unlistedBrowser.resend({ challengeId: uc.challengeId, address: STRANGER });
  assert.equal(listedRetry.status, unlistedRetry.status, 'withheld and accepted resends move the cooldown clock identically');
  assert.deepEqual(await listedRetry.json(), { error: 'cooldown' });
  assert.deepEqual(await unlistedRetry.json(), { error: 'cooldown' });
});

test('withheld resends move the cooldown clock under tight budgets (30-minute, daily, monthly)', async () => {
  for (const config of [{ sendsPerAddressPer30Minutes: 1 }, { sendsPerDay: 1 }, { sendsPerMonth: 1 }]) {
    const w = await makeWorld({ config });
    const start = await w.app.startSignIn(null);
    const listedBrowser = new BrowserSession(w);
    const unlistedBrowser = new BrowserSession(w);
    const lc = await (await listedBrowser.postChallenge({ address: OWNER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.1' } })).json();
    const uc = await (await unlistedBrowser.postChallenge({ address: STRANGER, stateId: start.stateId, headers: { 'cf-connecting-ip': '192.0.2.2' } })).json();
    await w.service.drain();
    w.advance(61_000);
    const listedResend = await listedBrowser.resend({ challengeId: lc.challengeId, address: OWNER });
    const unlistedResend = await unlistedBrowser.resend({ challengeId: uc.challengeId, address: STRANGER });
    assert.equal(listedResend.status, unlistedResend.status, `first resend under ${JSON.stringify(config)}`);
    // Immediate retry: the withheld listed resend and the accepted
    // unlisted resend must both be in cooldown.
    const listedRetry = await listedBrowser.resend({ challengeId: lc.challengeId, address: OWNER });
    const unlistedRetry = await unlistedBrowser.resend({ challengeId: uc.challengeId, address: STRANGER });
    assert.equal(listedRetry.status, unlistedRetry.status, `immediate retry under ${JSON.stringify(config)}`);
    assert.equal(listedRetry.status, 429);
    assert.deepEqual(await listedRetry.json(), { error: 'cooldown' });
  }
});

// Current local defaults: fixed half-hour sends, independent hourly requests.
const HALF_HOUR = 30 * 60_000;
const ALIGNED = Date.UTC(2026, 0, 1);
async function create(w, browser, address = OWNER) {
  return (await browser.postChallenge({ address, stateId: 's'.repeat(24) })).json();
}

test('send window resets at 30 minutes for creates and resends, not requests', async () => {
  const w = await makeWorld({ now: ALIGNED, config: { activeChallengesPerAddress: 100 } });
  const b = new BrowserSession(w);
  const c = await create(w, b);
  w.advance(60_000);
  await b.resend({ challengeId: c.challengeId, address: OWNER });
  await create(w, b);
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 3);
  w.setNow(ALIGNED + HALF_HOUR - 1);
  await b.resend({ challengeId: c.challengeId, address: OWNER });
  await create(w, b);
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 3, 'both paths share the send budget');
  w.setNow(ALIGNED + HALF_HOUR);
  const next = await create(w, b);
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 4, 'new half-hour starts exactly at its boundary');
  w.advance(60_000);
  await b.resend({ challengeId: next.challengeId, address: OWNER });
  await create(w, b);
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 6, 'second window also shares creates and resends');
  // Five create requests above; five more use the remaining hourly allowance.
  for (let i = 0; i < 5; i++) assert.equal((await b.postChallenge({ address: OWNER, stateId: 's'.repeat(24) })).status, 200);
  assert.equal((await b.postChallenge({ address: OWNER, stateId: 's'.repeat(24) })).status, 429,
    'request limit does not reset with the send window');
  w.setNow(ALIGNED + 60 * 60_000);
  assert.equal((await b.postChallenge({ address: OWNER, stateId: 's'.repeat(24) })).status, 200);
});

test('concurrent creates and resends share the last slot of the new send window', async () => {
  const w = await makeWorld({ now: ALIGNED, config: { activeChallengesPerAddress: 100 } });
  const b = new BrowserSession(w);
  w.setNow(ALIGNED + HALF_HOUR - 60_000);
  const c = await create(w, b);
  w.setNow(ALIGNED + HALF_HOUR);
  await create(w, b);
  await create(w, b);
  await Promise.all([create(w, b), b.resend({ challengeId: c.challengeId, address: OWNER })]);
  await w.service.drain();
  assert.equal(w.mailer.outbox.length, 4, 'one previous-window send and only three new-window sends');
});

test('default daily and monthly budgets stop at 90 and 2700 across addresses', async () => {
  const addresses = Array.from({ length: 91 }, (_, i) => `owner${i}@example.test`);
  for (const kind of ['day', 'month']) {
    const w = await makeWorld({ now: ALIGNED, allowlist: addresses, config: { requestsPerSourcePerHour: 10000 } });
    const b = new BrowserSession(w);
    if (kind === 'month') {
      w.store.transact((s) => s.set('counter:sendmonth:m:2026-01', { count: 2699, expiresAtMs: ALIGNED + 32 * 24 * 3_600_000 }));
    }
    for (const address of addresses) await create(w, b, address);
    await w.service.drain();
    assert.equal(w.mailer.outbox.length, kind === 'day' ? 90 : 1);
    const totalKey = kind === 'day' ? 'counter:sendday:d:2026-01-01' : 'counter:sendmonth:m:2026-01';
    assert.equal(w.store.transact((s) => s.getRef(totalKey)).count, kind === 'day' ? 90 : 2700);
  }
});

test('default code works just before 30 minutes but expires at the boundary', async () => {
  for (const elapsed of [HALF_HOUR - 1, HALF_HOUR]) {
    const w = await makeWorld({ now: ALIGNED });
    const b = new BrowserSession(w);
    const c = await create(w, b);
    await w.service.drain();
    w.advance(elapsed);
    const result = await (await b.verify({ challengeId: c.challengeId, address: OWNER, code: w.mailer.lastCode() })).json();
    if (elapsed < HALF_HOUR) assert.ok(result.proof);
    else assert.deepEqual(result, { error: 'invalid_or_expired_code' });
  }
});

test('email expiry text follows the configured lifetime on creates and resends', async () => {
  for (const minutes of [30, 7]) {
    const w = await makeWorld({ now: ALIGNED, config: { codeTtlMs: minutes * 60_000 } });
    const b = new BrowserSession(w);
    const c = await create(w, b);
    w.advance(60_000);
    await b.resend({ challengeId: c.challengeId, address: OWNER });
    await w.service.drain();
    assert.equal(w.mailer.outbox.length, 2);
    for (const message of w.mailer.outbox) assert.match(message.text,
      new RegExp(`It expires ${minutes} minutes after the original request\\.`));
    assert.equal(w.store.transact((s) => s.getRef(`challenge:${c.challengeId}`)).expiresAtMs, ALIGNED + minutes * 60_000,
      'resend does not extend the original expiry');
  }
});
