# Phase 1 Findings

Six local results and the cloud checks they still need.

The prototype tested restore safety, sign-in exchange, key refresh,
record cleanup, browser binding, and timing. These local results do not
establish cloud or real-browser behavior.

## 1. Restore safety (R14)

Result: in the local restore rehearsal, a code that came back from a
restore was rejected once the owner raised the epoch. The service did
not notice the restore on its own. The test set the epoch as unreadable
by hand to simulate the closed state.

The epoch is a number the owner raises after a restore. Every pending
sign-in attempt (challenge), issued proof, and app session carries it.
A proof is the signed message that says an address was checked. Tests
use a stand-in setting. If that setting cannot be read, nobody signs in.

The service and app reject items from an earlier epoch. The prototype
reads this value from the stand-in source and rejects sign-ins when it
cannot read it.

Finding: the rehearsal rejected a restored used code after an explicit
epoch raise. A separate test rejected an older-epoch proof and session,
with the app's session cleanup invoked by hand in that test. Not every
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

## 2. Returning the sign-in result to the app (R16)

Result: the local test refused an attacker's attempt to sign a victim into
the attacker's account. It used a short script to return the sign-in proof
to the app. A form submission was ruled out by analysis, not built or tested.

The callback is the app address that receives the proof. Login CSRF
(cross-site request forgery) signs a victim into an attacker's account.
A pre-auth cookie ties the requesting browser to the waiting sign-in.
SameSite is the cookie setting that limits which cross-site requests
carry it. CSP (content security policy) limits where a page may connect.
The script sends the proof to the exact app callback in one limited request.

The selected exchange returns the result to the same app and browser that
started sign-in. A script sends the proof to the exact app callback. The
app checks it and keeps the verified address with the waiting sign-in,
but does not create a session yet. The browser then opens the app's
completion page with no token in the URL. Its pre-auth cookie binds the
browser to that sign-in.

A form submission is unsafe here: a cross-site POST does not carry a
SameSite=Lax or Strict cookie. Without that cookie, the app cannot tie the
callback to the browser that started sign-in, so an attacker's sign-in
could finish in a victim's browser. This approach was rejected without
being built. The selected script exchange passed the local attack test.

Consequences for the Playbook: the code page's CSP sets
`connect-src 'self' <exact app origin>` per request and
`form-action 'none'`; the exchange window is 60 seconds and one-time.
No proof, code, or token appears in any URL, referrer, or log (asserted by
tests). Third-party cookies are never used, so Safari with cross-site
tracking prevention works by construction; a real Safari run remains
open for the cloud phase.

## 3. How long a revoked signing key stays trusted (R12)

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

## 4. Deleting expired records (R13, R6, E10)

Result: the purge is a housekeeping call that deletes what is eligible
when it runs. It does not run automatically or guarantee a one-hour deadline.

Terms: an idempotency record is a saved note that stops a double-click
from becoming two requests. A Durable Object is Cloudflare's small
stateful server with its own private storage. An alarm is a timer that
wakes it.

When the purge runs, it deletes expired challenges and issuances once an
hour has passed since they expired. It also deletes idempotency records and
address-linked counter state within 24 hours. The plain daily and monthly
send totals are kept for two days and 32 days after they are created,
not to the end of their periods (tested).

Production proposal: give each Durable Object, a stored set of service
records, one daily alarm that runs the cleanup. Each alarm uses a compute
request and each `setAlarm` writes a row (E10). One alarm per stored set
uses fewer operations than one for every sign-in attempt. A daily alarm
would not delete every expired attempt within an hour. Point-in-time
recovery keeps deleted rows restorable for 30 days regardless; this is
stated in the Playbook, and the epoch rule (finding 1) is what makes a
restored copy safe.

## 5. Codes stay tied to the requesting browser (R2, R8)

Result: an attacker can occupy both unfinished sign-in attempts. A code
from one of those attempts works only in the attacker's requesting browser,
not the owner's. The owner must wait for an attempt to free up, then start
a new one.

The earlier plan said "the real code is never invalidated; the owner is
delayed only." The test supports a narrower claim: the code is not
cancelled, but the owner cannot use it. The
alternative (dropping the browser binding) would let a phished or
observed code verify from any browser, which is the attack R2's
binding exists to stop. The binding stays (decision log S13, 7 October
2026).

## 6. Response timing and processor use (R3, R11)

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
- Behavior in real Safari.
