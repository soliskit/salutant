// R13 logging and R10 clean public repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld, honestSignIn, OWNER } from './helpers.js';

test('logs hold no codes, proofs or addresses; subject lines carry no code', async () => {
  const w = await makeWorld();
  const r = await honestSignIn(w);
  const logText = JSON.stringify(w.logSink);
  assert.ok(!logText.includes(r.code), 'no code in logs');
  assert.ok(!logText.includes(OWNER), 'no address in logs');
  assert.ok(!logText.includes(r.verified.proof), 'no proof in logs');
  for (const entry of w.logSink) {
    assert.deepEqual(Object.keys(entry).sort(), ['event', 'outcome', 'source', 'time']);
  }
  for (const mail of w.mailer.outbox) {
    assert.equal(mail.subject, 'Your sign-in code');
    assert.ok(!mail.subject.includes(r.code), 'the code appears only in the body');
  }
  // The store holds keyed hashes only.
  const dump = JSON.stringify([...w.store.records]);
  assert.ok(!dump.includes(r.code) && !dump.includes(OWNER));
});

// R10: scan the working tree for secrets and personal details. The scan
// is also a test so it runs in any future CI.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,                    // AWS access key id
  /xox[baprs]-[0-9A-Za-z-]{10,}/,        // Slack tokens
  /sk_live_[0-9a-zA-Z]{10,}/,            // Stripe live key
  /re_[0-9a-zA-Z]{20,}/,                 // Resend API key shape
  /\b[\w.+-]+@(?!example\.(test|com|org))[\w-]+\.[\w.]+\b/, // non-example addresses
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('the working tree holds no secrets or personal addresses', async () => {
  const hits = [];
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      if (pattern.test(text)) hits.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, [], 'scan must be clean');
});
