# Phase 1 findings: the four proposed production mechanisms

Lane C/D1. What the local prototype showed. Local results do not prove
cloud behavior; each finding says what the cloud phase must recheck.

## 1. Epoch (R14)

The mechanism that works in the prototype: every challenge, issuance,
proof and app session carries the epoch; the service and the app reject
anything from an earlier epoch; the service reads the epoch from an
injected source and fails closed when it cannot read it.

Finding: the design is enforceable end to end, and the rehearsed restore
went exactly as the contract says: restore keeps the service closed, an
owner epoch raise reopens it, and pre-raise codes and proofs are dead.

Still open (the candidate mechanism): a Worker environment variable
changed by the owner in the Cloudflare account. Not yet known: how fast
a changed value reaches every running copy, and whether a stale copy can
be read after the change. The prototype cannot answer this; it needs a
cloud test that changes the value and measures propagation. Until that
test passes, restore stays fail-closed by policy.

## 2. Callback protocol (R16)

Option 2 was built and tested; option 1 was rejected by protocol
analysis and never built. Result:

- Option 1 (form POST of the proof to the app callback) fails login
  CSRF by construction: a cross-site POST carries no SameSite=Lax or
  Strict cookie, so the app cannot bind the callback to the browser
  that started the sign-in. An attacker's verified state could be
  completed in a victim's browser. Rejected without an implementation.
- Option 2 (bounded exchange in script) passes the required login-CSRF
  mock test. The code page POSTs the
  proof cross-origin to the app's exact callback; the app verifies and
  binds the verified address to its server-side pending state, but
  creates no session yet. The browser then navigates top-level to the
  app's completion URL, which carries no token; the SameSite=Lax
  pre-auth cookie travels on that navigation and binds the browser.
  Attacker-owned state or proofs cannot log a victim into the attacker's
  session, because the verified state is bound to the attacker's cookie.

Consequences for the contract: the code page's CSP sets
`connect-src 'self' <exact app origin>` per request and
`form-action 'none'`; the exchange window is 60 seconds and one-time.
No proof, code or token appears in any URL, referrer or log (asserted by
tests). Third-party cookies are never used, so Safari with cross-site
tracking prevention works by construction; a real Safari run remains
open for the cloud phase.

## 3. Key cache and the staleness bound (R12)

The rehearsed routine rotation kept an old-key proof valid during the
overlap and removed it after. The rehearsed emergency revoke showed the
accepted window: an app whose cache was warm before the revoke still
accepted an old-key proof; once its cache ended and refresh failed, it
rejected everything (failed closed).

Finding for the open decision: the [10 minute] end-to-end bound
(endpoint cache [5] + app cache [5]) is implementable as specified.
Whether the owner accepts that emergency window is still his call
(decision log, open item 1). A shorter app cache would shrink the window
at the cost of more key-endpoint traffic.

## 4. Purge (R13, R6, E10)

The prototype purges expired challenges and issuances one hour after
expiry (so no record lives anywhere near 24 hours), purges idempotency
records and address-linked counter state within [24 hours], and keeps
the plain daily and monthly totals to the end of their periods
(tested).

Finding for production: on Durable Objects the purge should be
alarm-driven, and the cost model matters: an alarm invocation is a
compute request and each `setAlarm` is a row written (E10), so one
alarm per object per day is cheap, while one alarm per challenge is not.
Recommended: a single daily alarm per object. Point-in-time recovery
keeps deleted rows restorable for 30 days regardless; this is stated in
the contract, and the epoch rule (finding 1) is what makes a restored
copy safe.

## 5. Browser binding versus the slot-filling claim (R2, R8)

The plan claimed that under a slot-filling attack "the real code is
never invalidated; the owner is delayed only." The honest owner-path
test shows what the code actually does: the mailed code is never
invalidated, but it is bound to the browser that requested the
challenge (R2), and in a slot-filling attack that browser is the
attacker's. From the owner's own browser the mailed code fails with the
generic error. The owner recovers only by starting a fresh challenge
once a slot frees.

So the claim survives only in a narrowed form: the owner is delayed,
not locked out, and codes are never invalidated - but a code from an
attacker-created challenge is never usable by the owner. The
alternative (dropping the browser binding) would let a phished or
observed code verify from any browser, which is the attack R2's
binding exists to stop. This trade-off is the owner's call; the
prototype keeps the binding.

## What local testing does not prove

- The Workers 10 ms CPU limit (R11). Local CPU for a full sign-in
  measured well under that on the test machine (see the evidence doc),
  but the Workers CPU model differs. Recheck in the cloud phase.
- Real Durable Object transaction semantics under traffic.
- Real restore behavior of Durable Object point-in-time recovery.
- Safari, for real.
