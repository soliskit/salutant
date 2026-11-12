// R5 double submit: a resend refused for the cooldown is still one
// logical request. A repeat carrying the same idempotency key receives
// the recorded refusal instead of waiting on the first request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/storage.js';
import { DurableObjectStore } from '../src/do-store.js';
import {
  makeWorld,
  makeDOStorage,
  BrowserSession,
  OWNER,
  readCreated
} from './helpers.js';

/**
 * @typedef {import('../src/service.js').ServiceStore & {
 *   snapshot(): string,
 *   restoreFrom(snapshot: string): void
 * }} DriverStore
 */
/** @type {Array<[string, () => DriverStore]>} */
const DRIVERS = [
  ['MemoryStore', () => new MemoryStore()],
  ['DurableObjectStore', () => new DurableObjectStore(makeDOStorage())]
];

// A duplicate that only waits on the refused request must still answer.
// The bound turns "never answers" into a plain failure instead of a hang.
const SETTLE_MS = 2_000;
/**
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label
 * @returns {Promise<T>}
 */
function settled(promise, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`${label} did not settle within ${String(SETTLE_MS)} ms`)
      );
    }, SETTLE_MS);
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
  });
}

for (const [driver, storeFactory] of DRIVERS) {
  void test(`[${driver}] a later duplicate of a cooldown-refused resend replays the refusal`, async () => {
    const w = await makeWorld({ storeFactory });
    const browser = new BrowserSession(w);
    const start = await w.app.startSignIn(null);
    const created = await readCreated(
      await browser.postChallenge({ address: OWNER, stateId: start.stateId })
    );
    await w.service.drain();
    const key = `resend-cooldown-${driver}`;
    const first = await settled(
      browser.resend({
        challengeId: created.challengeId,
        address: OWNER,
        idempotencyKey: key
      }),
      'first resend'
    );
    assert.equal(first.status, 429);
    assert.deepEqual(await first.json(), { error: 'cooldown' });
    assert.equal(
      w.service._inflight.size,
      0,
      'the settled request left no in-flight entry behind'
    );
    const duplicate = await settled(
      browser.resend({
        challengeId: created.challengeId,
        address: OWNER,
        idempotencyKey: key
      }),
      'duplicate resend'
    );
    assert.equal(duplicate.status, 429);
    assert.deepEqual(await duplicate.json(), { error: 'cooldown' });
    assert.equal(w.mailer.outbox.length, 1, 'a refused resend sends no mail');
  });

  void test(`[${driver}] concurrent duplicates of a cooldown-refused resend both receive the refusal`, async () => {
    const w = await makeWorld({ storeFactory });
    const browser = new BrowserSession(w);
    const start = await w.app.startSignIn(null);
    const created = await readCreated(
      await browser.postChallenge({ address: OWNER, stateId: start.stateId })
    );
    await w.service.drain();
    const key = `resend-cooldown-concurrent-${driver}`;
    // Force and prove the interleaving this variant is about: the
    // second request must reach the idempotency check while the first
    // is still in flight. The leader's post-check hashes wait until
    // both requests computed their source hash, so the joiner branch is
    // taken deterministically, and the instrumented in-flight read
    // fails the test unless the joiner really awaited the in-flight
    // response. Instance-local; no service or global changes. The 2 s
    // settle bound turns a broken interleaving into a bounded failure.
    const ownHmac = Object.getOwnPropertyDescriptor(w.service, '_hmac');
    const originalHmac = w.service._hmac.bind(w.service);
    const inflight = w.service._inflight;
    const originalGet = inflight.get.bind(inflight);
    let joinerSawInFlight = false;
    inflight.get = (inflightKey) => {
      const pending = originalGet(inflightKey);
      if (inflightKey === key && pending) joinerSawInFlight = true;
      return pending;
    };
    let sourceHashes = 0;
    let releaseWork;
    const workReleased = new Promise((resolve) => {
      releaseWork = resolve;
    });
    w.service._hmac = async (hmacKey, message) => {
      const result = await originalHmac(hmacKey, message);
      if (message.startsWith('source:')) {
        sourceHashes += 1;
        if (sourceHashes === 2) setImmediate(releaseWork);
        return result;
      }
      await settled(workReleased, 'interleaving barrier');
      return result;
    };
    let first;
    let second;
    try {
      [first, second] = await settled(
        Promise.all([
          browser.resend({
            challengeId: created.challengeId,
            address: OWNER,
            idempotencyKey: key
          }),
          browser.resend({
            challengeId: created.challengeId,
            address: OWNER,
            idempotencyKey: key
          })
        ]),
        'concurrent duplicates'
      );
    } finally {
      if (ownHmac) Object.defineProperty(w.service, '_hmac', ownHmac);
      else Reflect.deleteProperty(w.service, '_hmac');
      inflight.get = originalGet;
    }
    assert.equal(sourceHashes, 2, 'both requests computed their source hash');
    assert.equal(
      joinerSawInFlight,
      true,
      'the joiner awaited the in-flight response, not a stored record'
    );
    assert.equal(
      inflight.size,
      0,
      'the settled requests left no in-flight entry behind'
    );
    assert.equal(first.status, 429);
    assert.equal(second.status, 429);
    assert.deepEqual(await first.json(), { error: 'cooldown' });
    assert.deepEqual(await second.json(), { error: 'cooldown' });
    assert.equal(w.mailer.outbox.length, 1, 'a refused resend sends no mail');
  });
}
