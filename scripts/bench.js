// R11 CPU sample harness (local only). Measures the local CPU of one
// full sign-in: challenge, mail mock, verify, Ed25519 sign, app-side
// verify and session issue. Run: node scripts/bench.js
// Local numbers say nothing about Workers CPU limits (cloud phase).
import { performance } from 'node:perf_hooks';
import { makeWorld, BrowserSession, honestSignIn, OWNER } from '../tests/helpers.js';

const RUNS = 20;
const samples = [];
let firstKeygenMs = 0;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const w = await makeWorld(); // includes one-time Ed25519 key generation
  const t1 = performance.now();
  if (i === 0) firstKeygenMs = t1 - t0;
  const cpu0 = process.cpuUsage();
  const r = await honestSignIn(w, { browser: new BrowserSession(w) });
  const cpu = process.cpuUsage(cpu0);
  if (r.complete.status !== 200) throw new Error('sign-in failed during bench');
  samples.push((cpu.user + cpu.system) / 1000);
}
// Key endpoint sample
const w = await makeWorld();
const cpu0 = process.cpuUsage();
await w.service.fetch(new Request('https://salutant.example.test/.well-known/jwks.json'));
const jwks = process.cpuUsage(cpu0);
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
console.log(JSON.stringify({
  runs: RUNS,
  signInCpuMs: { min: samples[0].toFixed(2), median: median.toFixed(2), max: samples.at(-1).toFixed(2) },
  firstRunKeygenWallMs: firstKeygenMs.toFixed(1),
  jwksCpuMs: ((jwks.user + jwks.system) / 1000).toFixed(2),
}, null, 1));
