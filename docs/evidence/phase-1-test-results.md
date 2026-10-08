# Phase 1 test results (lane D1)

Run on 7 October 2026, locally, on Node.js v22. Every result in this
document was produced against the exact reviewed tree at commit
b9f9b61ff189b98115ff2cb46d1f7bd164681949 on the `phase-1-local-mock-prototype` branch; the only change
after that commit is this document itself (it names the commit).
Command: `npm test` (zero dependencies). All runs in the local harness
with its own test state; no production limits or data exist.

## Full suite

71 tests, 71 pass, 0 fail, about 2.4 seconds. Files and what they prove:

- `tests/lifecycle.test.js` (R1, R2): correct code succeeds exactly
  once; reuse fails; wrong code gives one generic error and counts a
  try; expiry fails; five wrong tries end the challenge and a correct
  sixth fails; 25 simultaneous submits of one correct code give exactly
  one success; a resend kills only its own earlier code and separate
  challenges coexist; resend cooldown; cross-challenge and cross-browser
  reuse fail; at most two active challenges per address with the refusal
  indistinguishable and mail-free; no plain code or address in storage;
  purge removes expired challenges one hour after expiry; idempotency
  records purge within 24 hours; an unlisted address gets the same
  response shape and no mail.
- `tests/proof-exchange.test.js` (R4): a valid proof redeems into
  exactly one session; 20 parallel redemptions give one redemption and
  19 replay rejections; wrong issuer, audience, expiry, not-before and
  issue time rejected; altered body fails its signature; alg:none and
  foreign keys rejected; unknown key id rejected after one refresh;
  reused state rejected; a proof for another audience rejected; a
  correctly signed proof missing exp, nbf, iat or jti is rejected; the
  60-second exchange window runs from proof issuance, so a slow code
  step (including a resend after its 60-second cooldown) still
  exchanges, while a proof exchanged 61 seconds after issuance is
  rejected; the exchange boundary is pinned: 59,999 ms after issuance
  succeeds, 60,000 and 60,001 reject.
- `tests/failure-modes.test.js` (R5): an uncertain send is not retried,
  counts against budget and is reconciled; a failed send records the
  reservation and blocks no later retry; a failed send cannot verify -
  even with the exact code in hand, verify issues no proof because the
  reservation was never delivered; a double-click is one request (one
  challenge, one mail); an idempotent replay carries the original
  binding cookie, so a fresh-browser retry can still verify; a storage
  failure closes the service with nothing sent; an unreadable epoch
  closes every route; after a provider timeout the person can resend
  and complete the full sign-in through the exchange and session.
- `tests/limits.test.js` (R6, R8): per-source and per-address hourly
  request limits; every refusal - active cap, per-address budget,
  global budget - answers with the identical generic 200, body shape
  and binding-cookie shape for every address class, so no limit
  response reveals membership; the per-address send budget refuses the
  fourth request indistinguishably and sends no mail; an over-budget
  listed address and an unlisted address return byte-identical
  responses apart from the id fields; oversize bodies
  refused; the spoofed `x-forwarded-for` is ignored; address-linked
  state expires within 24 hours while the monthly total does not; the
  R8 attack test, honest owner path: a stranger fills the owner's two
  slots, the owner is delayed, the mailed code is unusable from the
  owner's browser (it is bound to the requesting browser, R2 - see
  finding 5) while remaining valid from the requesting browser, and the
  owner signs in end to end once a slot frees; 10 concurrent creates
  cannot exceed the active-challenge cap (2 live, 2 mails) or the
  hourly send budget (3 mails; the 7 refused requests write the same
  undeliverable records an unlisted acceptance writes, so nothing about
  them is observable); 10 concurrent resends after the cooldown produce
  exactly one resend; resend budget
  refusals are byte-identical for listed and unlisted addresses, at the
  default 3-per-hour budget and at a 1-per-hour budget (no 429 to
  reveal membership); withheld creates and resends evolve state exactly
  like unlisted acceptances (records, cooldown clock), so an immediate
  retry after a withheld resend meets the same 429 cooldown for both
  classes, under the default budget and under 1-per-hour, 1-per-day and
  1-per-month budgets;
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
- `tests/browser-protocol.test.js` (R16): full happy path using only
  first-party cookies (the harness asserts every Set-Cookie line is
  host-only, Secure, HttpOnly with the right SameSite; it does not
  emulate a browser's third-party-cookie policy - a real Safari run
  stays open for the cloud phase); all cookies first-party and
  host-only;
  wrong, sibling and lookalike origins refused; only the registered
  callback is returned and the completion URL carries no token; altered
  state rejected; CORS answers the service origin exactly; the required
  login-CSRF mock test passes (an attacker-owned state or proof cannot
  log the victim into the attacker's session); the completion window
  boundary is pinned: 59,999 ms after verification succeeds, 60,000
  and 60,001 reject.
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

Harness: `node scripts/bench.js` (20 runs, `process.cpuUsage` around a
full sign-in: challenge, mail mock, verify, Ed25519 sign, app verify,
session issue). Result: median 2.90 ms CPU, min 2.09 ms, max 65.40 ms
(the cold first run, dominated by one-time key generation and imports).
The key endpoint answered in 0.21 ms CPU. This does not prove the
Workers 10 ms free CPU limit; that is a cloud-phase measurement.

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
- Real mail delivery and the then-current provider gate for decision 2
  (Google terms and sending limits research for the dedicated Gmail
  account; Resend fallback). Historical plan at the time of this local
  mock run, now superseded by S27 in `docs/decision-log.md`. No real
  Gmail or Resend delivery was tested.
- The owner's review of the emergency-revoke window (open decision).
