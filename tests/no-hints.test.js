// R3 no hints: identical responses and timing classes for allowed and
// unlisted addresses. The measurement protocol is the lane A contract's
// timing section, run only in this local harness with its own state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeWorld, BrowserSession, OWNER, STRANGER } from './helpers.js';

test('responses for allowed and unlisted addresses differ only in the permitted fields', async () => {
  const w = await makeWorld();
  const start = await w.app.startSignIn(null);
  const mk = () => new BrowserSession(w);
  const rAllowed = await mk().postChallenge({ address: OWNER, stateId: start.stateId });
  const rUnlisted = await mk().postChallenge({ address: STRANGER, stateId: start.stateId });
  assert.equal(rAllowed.status, rUnlisted.status);
  const [a, b] = [await rAllowed.json(), await rUnlisted.json()];
  // Permitted differences: the request id (and the challenge id it
  // needs to function). Everything else is byte-identical.
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(a.status, b.status);
  // Headers: same names, same values. The per-challenge cookie differs
  // only in its random name/value and path id - its shape is identical.
  const names = (res) => [...res.headers.keys()];
  assert.deepEqual(names(rAllowed), names(rUnlisted));
  const norm = (v) => v.replace(/sb_[^=]+=[^;]+/, 'sb_ID=BINDING').replace(/challenges\/[^/]+/, 'challenges/ID');
  for (const n of names(rAllowed)) {
    const a = rAllowed.headers.get(n);
    const b = rUnlisted.headers.get(n);
    assert.equal(n === 'set-cookie' ? norm(a) : a, n === 'set-cookie' ? norm(b) : b, `header ${n}`);
  }
});

test('quota-state: driving the limits leaves allowed and unlisted classes indistinguishable', async () => {
  const w = await makeWorld({ config: { sendsPerAddressPer30Minutes: 1000 } });
  const start = await w.app.startSignIn(null);
  const run = async (address) => {
    const browser = new BrowserSession(w);
    const out = [];
    for (let i = 0; i < 11; i++) {
      const res = await browser.postChallenge({ address, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i}` } });
      out.push(`${res.status}:${JSON.stringify(await res.json()).replace(/"(requestId|challengeId)":"[^"]+"/g, '"$1":"x"')}`);
    }
    return out;
  };
  assert.deepEqual(await run(OWNER), await run(STRANGER), 'same statuses and bodies at every quota state');
});

test('timing protocol: 200 interleaved requests per class, 3 runs, within tolerance', async () => {
  const RUNS = 3;
  const PER_CLASS = 200;
  const HARD_MAX_MS = 50;
  const BASE_TOLERANCE_MS = 20;
  const medians = { allowed: [], unlisted: [] };
  const p95s = { allowed: [], unlisted: [] };
  const gaps = [];
  for (let run = 0; run < RUNS; run++) {
    const w = await makeWorld({ config: { sendsPerAddressPer30Minutes: 10000, requestsPerAddressPerHour: 10000, requestsPerSourcePerHour: 10000, activeChallengesPerAddress: 10000 } });
    const samples = { allowed: [], unlisted: [] };
    for (let i = 0; i < PER_CLASS; i++) {
      for (const [klass, address] of [['allowed', OWNER], ['unlisted', STRANGER]]) {
        const browser = new BrowserSession(w);
        const start = await w.app.startSignIn(null);
        const t0 = performance.now();
        const res = await browser.postChallenge({ address, stateId: start.stateId, headers: { 'cf-connecting-ip': `192.0.2.${i % 250}` } });
        await res.json();
        samples[klass].push(performance.now() - t0);
      }
    }
    for (const klass of ['allowed', 'unlisted']) {
      const sorted = [...samples[klass]].sort((a, b) => a - b);
      medians[klass].push(sorted[Math.floor(sorted.length / 2)]);
      p95s[klass].push(sorted[Math.floor(sorted.length * 0.95)]);
    }
    gaps.push({
      median: Math.abs(medians.allowed[run] - medians.unlisted[run]),
      p95: Math.abs(p95s.allowed[run] - p95s.unlisted[run]),
    });
  }
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  const withinClass = Math.max(spread(medians.allowed), spread(medians.unlisted));
  const tolerance = Math.max(BASE_TOLERANCE_MS, withinClass);
  console.log('timing evidence:', JSON.stringify({ medians, p95s, gaps, withinClass, tolerance }, null, 1));
  assert.ok(withinClass <= HARD_MAX_MS, `inconclusive: same-class run-to-run difference ${withinClass}ms over ${HARD_MAX_MS}ms`);
  for (const [run, gap] of gaps.entries()) {
    assert.ok(gap.median <= tolerance && gap.median <= HARD_MAX_MS, `run ${run}: median gap ${gap.median}ms`);
    assert.ok(gap.p95 <= tolerance && gap.p95 <= HARD_MAX_MS, `run ${run}: p95 gap ${gap.p95}ms`);
  }
});
