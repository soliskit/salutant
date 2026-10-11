# Phase 1 findings

This is what the local prototype showed. Local results do not prove
cloud behavior, so each finding says what the cloud phase must recheck.
There are six findings.

## 1. Epoch (R14)

Result: in the local restore rehearsal, a code that came back from a
restore was rejected once the owner raised the epoch. The service did
not notice the restore on its own. The test set the epoch as unreadable
by hand to simulate the closed state.

Terms: the epoch is a number the owner raises after a restore. A
challenge is one pending sign-in attempt. An issuance is one signed
proof handed to an app. A proof is the signed message that says an
address was checked. An injected source is a stand-in value the tests
supply instead of a real setting. Failing closed means that when
something is broken or unreadable, nobody signs in.

The prototype's mechanism: every challenge, issuance, proof and app
session carries the epoch. The service and the app reject anything from
an earlier epoch. The service reads the epoch from an injected source
and fails closed when it cannot read it.

Finding: the rehearsal rejected a restored used code after an explicit
epoch raise. A separate test rejected an older-epoch proof and session,
with the app's session cleanup invoked by hand in that test. Not each
case is tested: a restored used proof, a revoked key id and a cleared
lockout are gaps. The rehearsed restore went exactly as the Playbook
says. A restore keeps the service closed, an owner epoch raise reopens
it, and pre-raise codes and proofs are dead.

Still open, for the candidate mechanism (a Worker environment variable
the owner changes in the Cloudflare account): we do not yet know how
fast a changed value reaches every running copy, or whether a stale copy
can be read after the change. The prototype cannot answer this. It needs
a cloud test that changes the value and measures propagation. Until that
test passes, restore stays fail-closed by policy.

## 2. Callback protocol (R16)

Result: the bounded script exchange passed the local attack test. Protocol
analysis ruled out the form POST; we did not build or test it.

Terms: the callback is the app address the proof is sent to. Login CSRF
is an attack that completes an attacker's sign-in in a victim's
browser. The pending state is the app's server-side note that a sign-in
is waiting to finish. The pre-auth cookie is a cookie set before
sign-in that ties the browser to that sign-in. CSP (content security
policy) is a browser rule that limits where a page may connect. The
bounded script exchange is a short script on the code page that sends
the proof to the app's callback in one limited request.

- The form POST of the proof to the app callback fails login CSRF by
  construction: a cross-site POST carries no SameSite=Lax or
  Strict cookie, so the app cannot bind the callback to the browser
  that started the sign-in. An attacker's verified state could be
  completed in a victim's browser. Rejected without an implementation.
- The bounded script exchange passes the required login-CSRF mock
  test. The code page POSTs the proof cross-origin to the app's exact
  callback. The app verifies it and binds the verified address to its
  server-side pending state, but creates no session yet. The browser
  then navigates top-level to the app's completion URL, which carries no
  token. The SameSite=Lax pre-auth cookie travels on that navigation and
  binds the browser. Attacker-owned state or proofs cannot log a victim
  into the attacker's session, because the verified state is bound to
  the attacker's cookie.

Consequences for the Playbook: the code page's CSP sets
`connect-src 'self' <exact app origin>` per request and
`form-action 'none'`; the exchange window is 60 seconds and one-time.
No proof, code, or token appears in any URL, referrer, or log (asserted by
tests). Third-party cookies are never used, so Safari with cross-site
tracking prevention works by construction; a real Safari run remains
open for the cloud phase.

## 3. Key cache and how long an old key stays trusted (R12)

Result: after an emergency key revoke, an app can keep trusting the old
key for up to 10 minutes, and the prototype stays inside that bound.

Terms: a signing key is the secret the service uses to sign proofs. A
cache is a saved copy that is reused instead of fetched again, so a
changed key is not seen until the copy ages out. Rotation is the routine
swap to a new key. A revoke is the emergency removal of a key.

The rehearsed routine rotation kept an old-key proof valid during the
overlap and removed it after. The rehearsed emergency revoke showed the
allowed window: an app whose cache was warm before the revoke still
accepted an old-key proof; once its cache ended and refresh failed, it
rejected everything (failed closed).

Finding: the 10 minute end-to-end bound (endpoint cache of 5 minutes
plus app cache of 5 minutes) is implementable as specified. The key
endpoint is the web address where apps fetch the public signing keys.
The bound is a hard maximum for the owner-only trial (decision log S28),
with cloud proof pending. A shorter app cache would shrink the window at
the cost of more key-endpoint traffic.

## 4. Purge (R13, R6, E10)

Result: the purge is a housekeeping call that deletes what is eligible
when it runs. It is not an automatic one-hour deadline.

Terms: an idempotency record is a saved note that stops a double-click
from becoming two requests. A Durable Object is Cloudflare's small
stateful server with its own private storage. An alarm is a timer that
wakes it.

When the purge runs, it deletes expired challenges and issuances once an
hour has passed since they expired (so no expired challenge or issuance
lives anywhere near 24 hours). It also deletes idempotency records and
address-linked counter state within 24 hours. The plain daily and monthly
send totals are kept for two days and 32 days after they are created,
not to the end of their periods (tested).

Finding for production: on Durable Objects the purge should be
alarm-driven, and the cost model matters: an alarm invocation is a
compute request and each `setAlarm` is a row written (E10), so one
alarm per object per day is cheap, while one alarm per challenge is not.
Recommended: a single daily alarm per object. A once-daily alarm would
not delete expired challenges within an hour of their expiry. Point-in-time
recovery keeps deleted rows restorable for 30 days regardless; this is
stated in the Playbook, and the epoch rule (finding 1) is what makes a
restored copy safe.

## 5. Browser binding versus the slot-filling claim (R2, R8)

Result: an attacker who fills the open sign-in slots (a slot-filling
attack) can delay the owner, and the owner's mailed code fails in the
owner's own browser for that attacker-created challenge.

The plan claimed that under a slot-filling attack "the real code is
never invalidated; the owner is delayed only." The owner-path
test shows what the code does: the mailed code is never
invalidated, but it is bound to the browser that requested the
challenge (R2), and in a slot-filling attack that browser is the
attacker's. From the owner's own browser the mailed code fails with the
generic error. The owner recovers only by starting a fresh challenge
once a slot frees.

So the claim survives only in a narrowed form: the owner is delayed,
not locked out, and codes are never invalidated; but a code from an
attacker-created challenge is never usable by the owner. The
alternative (dropping the browser binding) would let a phished or
observed code verify from any browser, which is the attack R2's
binding exists to stop. The binding stays (decision log S13, 7 October
2026).

## 6. Timing and CPU (R3, R11)

Result: in an older local run, responses for allowed and unlisted addresses
looked the same in timing, and a full sign-in used little processor time
after the first cold run. Neither number proves anything about the cloud.

Terms: the median is the middle value of a set of samples. P95 is the
value that 95 percent of samples stay under. CPU time is the processor
time a request uses. Ed25519 is the signature algorithm that signs the
proofs.

These samples are from an older run, taken October 7, 2026 on Node 22 at
tree b9f9b61. They have not been rerun on current main.

Timing protocol (R3), measured: 200 interleaved requests per class, 3 runs,
local harness.

- Median per class per run: allowed 0.463 / 0.428 / 0.415 ms; unlisted
  0.462 / 0.426 / 0.403 ms.
- Median gap per run: 0.001 / 0.001 / 0.012 ms. P95 gap per run:
  0.529 / 0.037 / 0.111 ms.
- Same-class run-to-run difference: 0.059 ms. Tolerance: 20 ms (the larger
  of 20 ms and the run-to-run difference). Hard maximum: 50 ms. Result: pass
  in all three runs.

CPU sample (R11), local only: `node scripts/bench.js` (20 runs,
`process.cpuUsage` around a full sign-in: challenge, mail mock, verify,
Ed25519 sign, app verify, session issue). Median 2.90 ms CPU, min 2.09 ms,
max 65.40 ms (the cold first run, dominated by one-time key generation and
imports). The key endpoint answered in 0.21 ms CPU. These are local numbers
and say nothing about production hardware or the Workers 10 ms free CPU
limit; that is a cloud-phase measurement.

## What local testing does not prove

- The Workers 10 ms CPU limit (R11). The local median was 2.90 ms,
  but the cold first run reached 65.40 ms. These numbers do not prove
  compliance with that limit (see finding 6, an older run), and the
  Workers CPU model differs. Recheck in the cloud phase.
- Real Durable Object transaction semantics under traffic.
- Real restore behavior of Durable Object point-in-time recovery.
- Safari, for real.
