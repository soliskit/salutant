# Lane A contract, v1

The contract the phase 1 code is written against. The owner settled the
sign-in values on October 9, 2026 (S28-S39 in `docs/decision-log.md`); they
are written without brackets below. Values still in brackets remain
proposals; final values return to the owner with measured results.
Host names are recorded when the hosts exist, since none exist yet.
Requirement numbers (R1-R16) refer to the approved plan.

## Repo layout (settled here, per lane A ownership)

- `docs/decision-log.md` - lane A. Owner decision log.
- `docs/contract/` - lane A. This contract.
- `docs/mail/` - lane B. Mock mail adapter contract, provider research.
- `src/`, `tests/` - lane C. Mock service, stub app, tests.
- `docs/evidence/` - lane D1. Recorded results.
- `docs/findings/` - lane C/D1. Mechanism findings.
- No CI in phase 1; CI is a separate owner decision.

## Storage

Challenge and issuance records live in one SQLite-backed Durable Object
per the proposal; the app owns its own redemption record. Atomicity comes
from synchronous transactions: a check, update and consume with no await
between them. One object does not serialize async external operations:
while a mail call or other await is pending, another request can run, so
no state change may span an await. Past a free cap, operations fail with
an error, which the service treats as a failure and signs nobody in
(R5, R7). Whether this holds under real traffic is a cloud-phase finding.

## Epoch and restore boundary

OPEN, not filled. Requirement: a number the service reads and never
writes, which only the account owner can raise, kept outside the Durable
Object storage, carried by every record, proof and session; earlier-epoch
items are rejected; if it cannot be read the service stays closed; after
any restore it stays closed until the owner raises it. Candidate
(unverified): a Worker environment variable the owner changes in the
Cloudflare account, which takes effect with a new deployment. Prototype
finding: see docs/findings/phase-1-findings.md. Apps read the current
epoch with the public keys and drop earlier sessions. Trust boundary: the
Cloudflare account owner.

## Atomic state changes

Only the synchronous transaction section is serialized; nothing is
assumed to be serialized across an await. Every state change is one
transactional step: check the record, update it, and consume it, all in
one synchronous section with no await between the check and the write.
A challenge send first writes a durable reservation (request id, address
hash, counters) and only then calls the mail provider; the result is
recorded after. If the reservation write fails, nothing is sent. If the
send result is unknown, the reservation stays and counts against the
budget (R5). A code is consumed in the same step that verifies it; a
wrong try increments in that same step.

## Records and app test harness

The service keeps challenge and proof issuance records: challenge id,
address hash, attempts, state, epoch, and the proof id issued. Each app
keeps its own redemption record: proof id, time, and the session it
created. The service does not see sessions and the app does not see
challenges. Replay protection is the app checking the proof id against
its redemption record in one atomic step. Test harness for the app side:
a small stub app in the test suite that registers an origin and callback,
redeems proofs with its own store, and is used for replay, wrong-origin,
stale-key and epoch tests. No real app is touched.

## Endpoints

- `POST /v1/challenges` sends a code.
- `POST /v1/challenges/{id}/verify` checks it and returns a signed proof.
- `GET /.well-known/jwks.json` returns public keys and the current epoch.
- `GET /` and its script and style files are the code-entry page.

All on the Cloudflare Worker in production; all on the local mock in
phase 1.

## Origins and callbacks

The allowed app origins are an exact list of full origins, starting with
the first connected app's own Cloudflare origin (decision 4). No
wildcards and no sibling origins. Each app registers exact callback URLs
on its origin, for example its origin plus `/auth/callback`, matched in
full. `Access-Control-Allow-Origin` is that one exact origin and never
`*`. Exact host names are recorded when the hosts exist.

## Callback protocol

Two options, decided by prototype test (finding in
docs/findings/phase-1-findings.md):

- Option 1 (preferred before testing): the code page's `form-action`
  allows only the exact registered callback origin for that request, set
  in code, and the proof is POSTed to the registered callback URL.
- Option 2: the page returns the proof to the app through a bounded
  exchange in script, with a one-time exchange that expires in
  [60 seconds] and works once.

Never a redirect with a proof, and never a token in a URL. State: the app
creates a random state value and keeps it as a server-side record keyed
by a state id that travels in the POST body and inside the signed proof.
A state cookie does not travel on a cross-site POST under SameSite Lax or
Strict, and SameSite None would weaken it, so the cookie is not the
transport; whether the server-side record is enough to bind the browser
session is a prototype finding. The app checks the signature, key id,
epoch, audience (its own origin), expiry, state and proof id, then
creates its session. No tokens, codes or proofs in URLs, referrers or
logs. On epoch change or emergency revoke the app drops sessions issued
before the new epoch and its cached keys.

Required mock test: cross-site login CSRF with attacker-owned state - an
attacker's state or proof must not log the victim into the attacker's
session.

## Signature and keys

Ed25519 (EdDSA), the one pinned algorithm. The private key is a service
secret. Public keys are published at the key endpoint with their key ids
and cached by apps for at most 5 minutes; with the 5-minute endpoint
cache the end-to-end bound is 10 minutes, settled as a hard maximum for
the owner-only trial, conditional on cloud proof (S28). Codes come from the secure
random function and are compared with a timing-safe comparison.

## Security headers

Every response the service generates carries:

- `Content-Security-Policy`: `default-src 'none'`, `script-src 'self'`,
  `style-src 'self'`, `connect-src 'self'` plus the one exact callback
  origin when the page is served for a sign-in, `img-src 'self'`,
  `form-action` limited as set in the callback protocol, `base-uri
  'none'`, `frame-ancestors 'none'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Strict-Transport-Security: max-age=31536000`
- `Permissions-Policy` denying camera, microphone and geolocation
- `Cross-Origin-Opener-Policy: same-origin`
- `Cache-Control: no-store` on sign-in and proof responses

The key endpoint may be cached for [5 minutes]. These are set in code
because a static header file does not cover generated responses.

## Sending rule (provider-neutral)

The current mail path is Resend from mail.soliskit.com (S27 in
`docs/decision-log.md`), replacing decision 2's dedicated Gmail path.
The adapter remains provider-neutral. Whatever the provider:

- The sender is a no-reply address on a dedicated sending subdomain of
  the owner domain, never a personal mailbox, never an address someone
  reads.
- Open and click tracking are off.
- The mail adapter interface (docs/mail/mock-mail-adapter-contract.md)
  hides the provider from the service.
- Whether Google's terms and sending limits allow automated sign-in
  email is unverified; research is a gate of the real-delivery phase.
  Account creation and any real credential (through a vault link, never
  chat) are later, separately approved phases.

## Proposed values

Code expiry 30 minutes (S30). Wrong tries 5 (S31). Active challenges per
address 2 (S33). Sends per address 3 per 30 minutes, including resends
(S34). Requests per address 10 per hour (S36). Requests per source 10 per
hour (S36). Resend cooldown one minute (S32). Sends overall at most 90
percent of the mail provider's current free allowance: 90 per day and
2,700 per month at the free plan of 100 per day and 3,000 per month,
checked October 9, 2026 (S35). Body limit [2 KB]. Proof lifetime 5
minutes (S37). Clock skew one minute (S38). Key cache 5 minutes at the
app, 5 at the endpoint, 10 end to end, settled as a hard maximum for the
owner-only trial, conditional on cloud proof (S28). CPU margin
[20 percent]. App log retention 14 days; logs never contain email
addresses, codes or proofs (S39). Address-linked state deleted within
24 hours; single-use protection still needed is not removed early (S39).

## Timing measurement protocol

Runs only in the local test harness with its own test state, so no
production limit is bypassed and no production data is used. Any
test-state limit resets only inside the harness. Mail is stubbed; no real
emails are sent. Send [200] interleaved requests per class (allowed and
unlisted) from one client, in [3] separate runs. Per run compare the
median and the 95th percentile between classes. Tolerance is the larger
of [20 ms] and the run-to-run difference within one class, with a hard
maximum of [50 ms]: any gap over the hard maximum fails, whatever the
run-to-run noise. Pass: gap inside tolerance in all three runs.
Inconclusive: the same-class difference exceeds the hard maximum, or
fewer than three clean runs. An inconclusive result is rerun once, then
reported as it stands, not as a pass. Measured values are reviewed by the
owner before launch.

## Key staleness bound

One end-to-end number: after an emergency revoke, an app may accept an
old key for at most 10 minutes in total, counting the endpoint cache
(5 minutes on the key response) and the app cache together; the app
cache setting is therefore 5 minutes and the endpoint cache
5 minutes, and no layer may hold a key longer than its own setting. An
app that cannot refresh after its cache ends rejects every proof (fails
closed). Settled as a hard maximum for the owner-only trial, conditional
on cloud proof (S28).

## Cost and limits check

Cloudflare Workers Free: 100,000 requests per day; operations fail past
the limit. Durable Objects Free: 100,000 requests per day, 5 million rows
read, 100,000 rows written, 5 GB, 13,000 GB-s duration per day. An alarm
invocation is a compute request and each `setAlarm` is a row written, so
purge work uses those same budgets. The limits are shared across the
whole account, not per object, so any other use of the account counts
too. Storage is deleted by purge, but point-in-time recovery keeps
database contents for 30 days, so a purged code can still be restored
within that window; this is stated, not hidden. GitHub Actions is free
for public repos. Before any setup the owner confirms the Cloudflare
account is on the free plan with no payment method needed; if it is not,
setup stops. Total: no billable item (R7). Re-read at each milestone.
