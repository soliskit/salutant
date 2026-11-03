# Phase 1 Findings

Six local results, the cloud checks they still need, and source-review
findings from two read-only council reviews held on November 2, 2026,
at commit 1db328a39f745b25aa255905f15f7c24cb8fd704.

The prototype tested restore safety, sign-in exchange, key refresh,
record cleanup, browser binding, and timing. These local results do not
establish cloud or real-browser behavior. Findings 7 through 12 come
from source review at the pinned commit, not from test runs.

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
lockout are gaps. The rehearsal simulated a closed service after restore and an explicit
owner epoch raise. Automatic restore detection is not merely unproven:
nothing implements it. The snapshot and restore functions exist with no
production caller.

Still open, for the candidate mechanism (the EPOCH Worker secret the
owner changes in the Cloudflare account; the service's only environment
variable is SERVICE_ORIGIN): we do not yet know how fast a changed value
reaches every running copy, or whether a stale copy can be read after
the change. The production entry reads the epoch once per Durable Object
build and holds it for the object's life, so the measurement must
account for object rebuild timing, and the public-keys response
(5-minute cache) is the readable epoch source. Rate and send counters
carry no epoch, so the cleared-lockout gap above is partly structural,
not only untested. App session cleanup is explicit: dropSessionsBefore
must be invoked. The prototype cannot answer the propagation question.
It needs a cloud test that changes the value and measures propagation.
Until that test passes, restore stays fail-closed by policy.

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

Consequences for [Requirements](../requirements.md): the code page's CSP sets
`connect-src 'self' <exact app origin>` per request and
`form-action 'none'`; the exchange window is 60 seconds and one-time.
No proof or code appears in any URL, referrer, or log (asserted by
tests); the app's state id does appear in the code-page URL (the stub
app builds `?app=...&state=...`), a route the requirements' state bullet
omits. The design uses no third-party cookies. A real Safari run with cross-site
tracking prevention remains open for the cloud phase.

Open items added November 2, 2026: the service accepts any state id of
16 or more characters without tying it to the requesting browser, so a
victim-state-id chain is source-plausible: an attacker who learns the
victim's state id and holds a listed address the owner does not control
could attach a verified address to the victim's waiting sign-in. While
the allowlist holds only owner-controlled addresses, no such attacker
address exists; that is a configuration fact, not a proof the chain is
impossible. The production exchange and completion windows remain
unapproved, and the stub app is not proof of a deployed callback. No
OPTIONS or preflight handling exists anywhere, so the real-browser run
should cover the cross-origin JSON preflight the stub does not model.

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
The bound is a hard maximum for the owner-only trial,
with cloud proof pending. A shorter app cache would shrink the window at
the cost of more key-endpoint traffic.

Added November 2, 2026: the adopted 10-minute bound runs from the
owner's emergency revoke. Signing keys are read once per object build.
The revoke-to-publication interval (object pickup) is unproved extra
delay that must fit inside the adopted bound; measuring that pickup is
the same cloud check as finding 1's propagation item.

## 4. Deleting expired records (R13, R6, E10)

Result: the purge is a housekeeping call that deletes what is eligible
when it runs. It does not run automatically. Its one-hour figure is an eligibility threshold, not an adopted deadline.

Terms: an idempotency record is a saved note that stops a double-click
from becoming two requests. A Durable Object is Cloudflare's small
stateful server with its own private storage. An alarm is a timer that
wakes it.

When the purge runs, it deletes expired challenges and issuances once an
hour has passed since they expired. When it runs, it also deletes idempotency
records created 24 hours or more ago, and address-linked counter
state whose stored expiry has been reached. The plain daily and monthly
send totals are kept for two days and 32 days after they are created,
not to the end of their periods (tested).

Production proposal: give each Durable Object, a stored set of service
records, one daily alarm that runs the cleanup. Each alarm uses a compute
request and each `setAlarm` writes a row (E10). One alarm per stored set
uses fewer operations than one for every sign-in attempt. A daily alarm
would not delete every expired attempt within an hour. Measured
against the adopted 24-hour deletion deadline, the worst cases are
hypothetical and approximate: about 25 hours for a challenge (eligible
at expiry plus one hour, about creation plus 90 minutes by default) and
about 48 hours for an idempotency record (eligible at creation plus 24
hours). The pinned production entry source has no purge caller at all,
so no finite automatic deletion bound is established by that source.
Idempotency rows and reservations become eligible exactly at creation
plus 24 hours; the adopted texts do not state the deadline clock's
starting event, so that uncertainty stays open, and any threshold
adjustment is an engineering recommendation under the per-fix route.
The purge also rewrites every record it keeps: the production store
writes back every record read through getRef. Reservations hold the
address hash and were omitted from the list above. Provider recovery terms live in [E10](../evidence-record.md#platform-notes-and-their-evidence-limits):
under 30-day point-in-time recovery, deletion is not the end of retention.
The epoch rule (finding 1) is the planned protection for restored data.

### Service log cleanup

The local service appends events to an in-memory array in
[src/service.js](../../src/service.js), in the constructor and log method.
Neither method nor the purge method ages out those entries. The approved
service-log retention is therefore not implemented by this local
array. This source check was made October 12, 2026; it is not a cloud result.
Added November 2, 2026: the in-memory log array is the production log -
the entry passes no log destination.

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
binding exists to stop. The binding stays.

Qualification added November 2, 2026: the binding is to the cookie
value. A retained create idempotency key whose recorded response
carried the real binding cookie can recover that cookie from another
client; a send-limit-withheld create also returns the real ids and the
real binding cookie (indistinguishable from an acceptance on the
wire), so its recording is a real-cookie case too. Resend and error
recordings carry no cookie; cap-refusal stand-in recordings carry a
synthetic binding-shaped cookie that binds no record, so replaying one
returns a value that verifies nothing. The
key and cookie alone are not verification authority: a successful
verify still requires the correct code and address and a challenge
that is listed, open, delivered, within attempts, unexpired, and
epoch-matched. Open items: withheld challenges occupy attempt slots;
attacker-opened challenges for a listed address consume the shared
daily send budget, and exhaustion withholds all attempts until the UTC
day turns over; resends skip the request-rate check.

## 6. Response timing and processor use (R3, R11)

Result: in an older local run, responses for allowed and unlisted addresses
looked the same in timing, and a full sign-in used little processor time
after the first cold run. Neither number proves anything about the cloud.

Terms: the median is the middle value of a set of samples. P95 is the
value that 95 percent of samples stay under. CPU time is the processor
time a request uses. Ed25519 is the signature algorithm that signs the
proofs.

These are older local numbers, not rerun on current main, and say nothing about the cloud.

Added November 2, 2026: R3's real-platform check stays pending alongside
the items below. The production path (Durable Object store, Resend
adapter) differs from the measured tree, and listed, unlisted, and
withheld requests do different storage work despite comments claiming
identical work.

## 7. Public idempotency writes

Source-review finding, November 2, 2026, at the pinned commit.

- In-flight leak: the in-flight entry is cleared only by the recording
  step. The resend-cooldown response (a plain responder) and any error
  after the entry is set leave it unresolved, a later same-key request
  waits on a promise nothing resolves, and the map grows per stuck key.
- No membership gate: unlisted addresses pass the same checks and are
  recorded identically; membership decides only mail and counters.
- Idempotency rows are not the main write cost: getRef write-back means
  each new-challenge request rewrites every stored challenge, and with
  no purge that set only grows.
- The key has no length or format check. The 2 KB cap covers the body
  only. A syntactically valid non-object body (for example null) raises
  before recording.
- The binding storage cap is 1 GB per object (a single named object,
  E10), not the 5 GB account total.
- Writing the row is conditional on the storage transaction succeeding;
  a throw leaves both no row and a stuck in-flight entry.
- Plan nuance: the basis records Workers Free (owner-confirmed
  November 2, 2026, evidence record R7 entry). What source review
  cannot establish is that a deploy targets that account (finding 10).

## 8. Replay material and taxonomy

Source-review finding, November 2, 2026, at the pinned commit.

- Replay runs before the rate check.
- The row stores only status, body, cookie, and time - never the
  original request - so any source can replay a known key any number of
  times.
- The 400 and 429 error recordings belong in the recording taxonomy
  alongside the success, resend, withheld, and gone cases; one list
  should hold every case.
- Cookie cases are qualified in finding 5: a replay returns the
  recorded cookie when the recorded response carried one.

## 9. Automatic rerun path

Source-review finding, November 2, 2026, at the pinned commit.

- A rerun does establish that the four secrets exist by name and type
  (the deploy workflow's state step), though not their values; it
  checks nothing in Durable Object storage.
- Verification also checks attempts, delivery, and the code and binding
  hashes. All hashes depend on the HMAC secrets, which a FIRST run
  regenerates, so after a first run no old challenge can verify.
  Idempotency rows replay unconditionally. Daily and monthly totals
  carry no hash and carry over on either path.
- "The secrets mechanism preserves omitted secrets" previously rested
  on a workflow comment. The mechanism is now recorded in the evidence
  record (E13) from Cloudflare's wrangler commands reference:
  documentation evidence plus a version-ordering inference, not
  live-executed proof.
- The riskier FIRST case is a first run against an existing worker: it
  plants EPOCH from the repository value (possibly lowering a raised
  epoch) and replaces signing and HMAC secrets. The only guard reads
  "404 with error 10007" as worker-absent, and the workflow's own
  comment gives 10007 two meanings.
- "Automatic" means the path is chosen automatically; runs are started
  by hand (workflow_dispatch only).

## 10. Wrong-account targeting

Source-review finding, November 2, 2026, at the pinned commit.

- Every rerun also writes RESEND_API_KEY, MAIL_FROM, ALLOWLIST, and
  APPS. Secrets are not readable through the API, but any code deployed
  to the worker can read them.
- There are no branch or deployment conditions: manual dispatch only,
  deploying whatever branch it was started from.
- A failed deploy may already have written secrets; upload and domain
  setup are one command.
- The target comes from CLOUDFLARE_ACCOUNT_ID as well as token reach.

## 11. Failed service build is cached

Source-review finding, November 2, 2026, at the pinned commit. A failed
service build is memoized for the Durable Object's life: the build
promise is cached in the object's fetch and never reset, so every later
request re-awaits the same rejection, and its errors skip the security
headers the worker applies.

## 12. Signing-key lookup after consumption

Source-review finding, November 2, 2026, at the pinned commit. A
missing signing key is discovered only after the code is consumed: the
challenge is marked consumed inside the verification transaction, and
the signing-key lookup happens after.

## What local testing does not prove

- The Workers CPU limit (R11), recorded in E2. The older samples in finding 6 do not prove
  compliance with that limit, and the
  Workers CPU model differs. Recheck in the cloud phase.
- Real Durable Object transaction semantics under traffic.
- Real restore behavior of Durable Object point-in-time recovery.
- Behavior in real Safari.
