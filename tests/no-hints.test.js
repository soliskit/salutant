// R3 no hints: identical responses and timing classes for allowed and
// unlisted addresses. Timing is measured only in this local
// harness, with its own state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeWorld, BrowserSession, OWNER, STRANGER } from './helpers.js';

void test('responses for allowed and unlisted addresses differ only in the permitted fields', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const mk = () => new BrowserSession(w);
  const rAllowed = await mk().postChallenge({
    address: OWNER,
    stateId: start.stateId
  });
  const rUnlisted = await mk().postChallenge({
    address: STRANGER,
    stateId: start.stateId
  });
  assert.equal(rAllowed.status, rUnlisted.status);
  const [a, b] = [await rAllowed.json(), await rUnlisted.json()];
  // Permitted differences: the request id (and the challenge id it
  // needs to function). Everything else is byte-identical.
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(a.status, b.status);
  // Headers: same names, same values. The per-challenge cookie differs
  // only in its random name/value and path id - its shape is identical.
  /** @param {Response} res */
  const names = (res) => [...res.headers.keys()];
  assert.deepEqual(names(rAllowed), names(rUnlisted));
  /** @param {string | null} v */
  const norm = (v) => {
    assert.ok(v !== null, 'response has no set-cookie header');
    return v
      .replace(/sb_[^=]+=[^;]+/, 'sb_ID=BINDING')
      .replace(/challenges\/[^/]+/, 'challenges/ID');
  };
  for (const n of names(rAllowed)) {
    const a = rAllowed.headers.get(n);
    const b = rUnlisted.headers.get(n);
    assert.equal(
      n === 'set-cookie' ? norm(a) : a,
      n === 'set-cookie' ? norm(b) : b,
      `header ${n}`
    );
  }
});

void test('quota-state: driving the limits leaves allowed and unlisted classes indistinguishable', async () => {
  const w = await makeWorld({ config: { sendsPerAddressPer30Minutes: 1000 } });
  const start = await w.app.startSignIn(null);
  /** @param {string} address */
  const run = async (address) => {
    const browser = new BrowserSession(w);
    const out = [];
    for (let i = 0; i < 11; i++) {
      const res = await browser.postChallenge({
        address,
        stateId: start.stateId,
        headers: { 'cf-connecting-ip': `192.0.2.${String(i)}` }
      });
      out.push(
        `${String(res.status)}:${JSON.stringify(await res.json()).replace(/"(requestId|challengeId)":"[^"]+"/g, '"$1":"x"')}`
      );
    }
    return out;
  };
  assert.deepEqual(
    await run(OWNER),
    await run(STRANGER),
    'same statuses and bodies at every quota state'
  );
});

void test('timing protocol: 200 interleaved requests per class, 3 runs, within tolerance', async () => {
  const RUNS = 3;
  const PER_CLASS = 200;
  const HARD_MAX_MS = 50;
  const BASE_TOLERANCE_MS = 20;
  /** @type {{ allowed: number[], unlisted: number[] }} */
  const medians = { allowed: [], unlisted: [] };
  /** @type {{ allowed: number[], unlisted: number[] }} */
  const p95s = { allowed: [], unlisted: [] };
  const gaps = [];
  for (let run = 0; run < RUNS; run++) {
    const w = await makeWorld({
      config: {
        sendsPerAddressPer30Minutes: 10000,
        requestsPerAddressPerHour: 10000,
        requestsPerSourcePerHour: 10000,
        activeChallengesPerAddress: 10000
      }
    });
    /** @type {{ allowed: number[], unlisted: number[] }} */
    const samples = { allowed: [], unlisted: [] };
    for (let i = 0; i < PER_CLASS; i++) {
      /** @type {Array<['allowed' | 'unlisted', string]>} */
      const classAddresses = [
        ['allowed', OWNER],
        ['unlisted', STRANGER]
      ];
      for (const [klass, address] of classAddresses) {
        const browser = new BrowserSession(w);
        const start = await w.app.startSignIn(null);
        const t0 = performance.now();
        const res = await browser.postChallenge({
          address,
          stateId: start.stateId,
          headers: { 'cf-connecting-ip': `192.0.2.${String(i % 250)}` }
        });
        await res.json();
        samples[klass].push(performance.now() - t0);
      }
    }
    /** @type {Array<'allowed' | 'unlisted'>} */
    const classes = ['allowed', 'unlisted'];
    for (const klass of classes) {
      const sorted = [...samples[klass]].sort((a, b) => a - b);
      medians[klass].push(sorted[Math.floor(sorted.length / 2)]);
      p95s[klass].push(sorted[Math.floor(sorted.length * 0.95)]);
    }
    gaps.push({
      median: Math.abs(medians.allowed[run] - medians.unlisted[run]),
      p95: Math.abs(p95s.allowed[run] - p95s.unlisted[run])
    });
  }
  /** @param {number[]} xs */
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  const withinClass = Math.max(
    spread(medians.allowed),
    spread(medians.unlisted)
  );
  const tolerance = Math.max(BASE_TOLERANCE_MS, withinClass);
  console.log(
    'timing evidence:',
    JSON.stringify({ medians, p95s, gaps, withinClass, tolerance }, null, 1)
  );
  assert.ok(
    withinClass <= HARD_MAX_MS,
    `inconclusive: same-class run-to-run difference ${String(withinClass)}ms over ${String(HARD_MAX_MS)}ms`
  );
  for (const [run, gap] of gaps.entries()) {
    assert.ok(
      gap.median <= tolerance && gap.median <= HARD_MAX_MS,
      `run ${String(run)}: median gap ${String(gap.median)}ms`
    );
    assert.ok(
      gap.p95 <= tolerance && gap.p95 <= HARD_MAX_MS,
      `run ${String(run)}: p95 gap ${String(gap.p95)}ms`
    );
  }
});
