# Phase 1 test results (lane D1)

Run on 7 October 2026, locally, on Node.js v22, against the exact head
of the `phase-1-local-mock-prototype` branch. Command: `npm test`
(zero dependencies). All runs in the local harness with its own test
state; no production limits or data exist.

## Full suite

53 tests, 53 pass, 0 fail, about 2.3 seconds. Files and what they prove:

- `tests/lifecycle.test.js` (R1, R2): correct code succeeds exactly
  once; reuse fails; wrong code gives one generic error and counts a
  try; expiry fails; five wrong tries end the challenge and a correct
  sixth fails; 25 simultaneous submits of one correct code give exactly
  one success; a resend kills only its own earlier code and separate
  challenges coexist; resend cooldown; cross-challenge and cross-browser
  reuse fail; at most two active challenges per address with the refusal
  indistinguishable and mail-free; no plain code or address in storage;
  purge removes expired challenges; an unlisted address gets the same
  response shape and no mail.
- `tests/proof-exchange.test.js` (R4): a valid proof redeems into
  exactly one session; 20 parallel redemptions give one redemption and
  19 replay rejections; wrong issuer, audience, expiry, not-before and
  issue time rejected; altered body fails its signature; alg:none and
  foreign keys rejected; unknown key id rejected after one refresh;
  reused state rejected; a proof for another audience rejected.
- `tests/failure-modes.test.js` (R5): an uncertain send is not retried,
  counts against budget and is reconciled; a failed send records the
  reservation and blocks no later retry; a double-click is one request
  (one challenge, one mail); a storage failure closes the service with
  nothing sent; an unreadable epoch closes every route; after a provider
  timeout the person can resend and sign in.
- `tests/limits.test.js` (R6, R8): per-source and per-address hourly
  request limits; per-address send budget; oversize bodies refused; the
  spoofed `x-forwarded-for` is ignored; address-linked state expires
  within 24 hours while the monthly total does not; the R8 attack test:
  a stranger fills the owner's two slots, the owner is delayed but the
  real code still works, and the delay ends when the attacker's
  challenges expire.
- `tests/headers.test.js` (R9): every route type (page known and unknown
  app, script, style, challenge, verify error, key endpoint, 404)
  carries the full header set; no-store on sign-in and proof responses;
  the key endpoint is cacheable for exactly 300 seconds; the page's CSP
  limits connect-src to the one exact app origin and sets
  `form-action 'none'`; a lookalike origin is not served the page.
- `tests/no-hints.test.js` (R3): allowed and unlisted responses differ
  only in the permitted id fields; driving the limits leaves the two
  classes indistinguishable at every quota state; the timing protocol
  passes (below).
- `tests/restore-epoch.test.js` (R14, R12, R15): restore rehearsal
  (closed until the owner raises the epoch, then old items rejected and
  new challenges work); a pre-raise code is not reusable; routine
  rotation with overlap; emergency revoke with the accepted warm-cache
  window and fail-closed after; old-epoch proofs rejected and the app
  drops earlier sessions; the key endpoint reports the current epoch.
- `tests/browser-protocol.test.js` (R16): full happy path with
  third-party cookies blocked; all cookies first-party and host-only;
  wrong, sibling and lookalike origins refused; only the registered
  callback is returned and the completion URL carries no token; altered
  state rejected; CORS answers the service origin exactly; the required
  login-CSRF mock test passes (an attacker-owned state or proof cannot
  log the victim into the attacker's session); the 60-second exchange
  window is enforced.
- `tests/logging-hygiene.test.js` (R13, R10): logs hold no codes, proofs
  or addresses; subjects carry no code; the working tree scan for
  secrets and non-example addresses is clean.

## Timing protocol (R3), measured

200 interleaved requests per class, 3 runs, local harness:

- Median per class per run: allowed 0.463 / 0.428 / 0.415 ms; unlisted
  0.462 / 0.426 / 0.403 ms.
- Median gap per run: 0.001 / 0.001 / 0.012 ms. P95 gap per run:
  0.529 / 0.037 / 0.111 ms.
- Same-class run-to-run difference: 0.059 ms. Tolerance: 20 ms
  (the larger of 20 ms and the run-to-run difference). Hard maximum:
  50 ms. Result: pass in all three runs.

Local numbers only; they say nothing about production hardware.

## CPU sample (R11), local only

A full sign-in (challenge, mail mock, verify, Ed25519 sign, app verify)
took about 57 ms of local CPU total, dominated by one-time key
generation and imports; the steady-state request paths are sub-millisecond
locally. The key endpoint answered in about 0.6 ms. This does not prove
the Workers 10 ms free CPU limit; that is a cloud-phase measurement.

## Header captures (R9)

Asserted programmatically per route type in `tests/headers.test.js`;
the assertions name each required header and value.

## Scans (R10, R13)

Automated in `tests/logging-hygiene.test.js`: log sink, mail subjects,
storage dump, and a working-tree scan (private keys, common token
shapes, non-example email addresses). All clean at the head commit.

## Not done here (open for later phases)

- Real Safari run (needs deployed hosts).
- Workers CPU and Durable Object semantics (cloud phase).
- Real mail delivery and the provider gate for decision 2 (Google
  terms and sending limits research for the dedicated Gmail account;
  Resend fallback).
- The owner's review of the emergency-revoke window (open decision).
