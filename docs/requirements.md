# Salutant Requirements

The sign-in contract, acceptance checks, and choices still open.

Bracketed values are proposals, not approved production settings. Local implementation is not cloud proof. [Decisions](decision-log.md) owns approved choices; [evidence](evidence-record.md) owns results and provider facts.

## Purpose and boundary

This contract covers Milestone 1, First code. The trial is owner-only; estimated volumes are not measured demand. Salutant checks an address and issues a signed proof, and publishes its public keys and epoch. The app redeems the proof once and owns its session and replay record.

## Sign-in flow

1. Enter an email address in the app.
2. Salutant sends a code to the inbox. Phase 1 uses stand-in mail only.
3. Enter the code in the browser that requested it. It expires and works once; the approved lifetime lives in S30.
4. The app checks Salutant's signed proof and completes sign-in. It owns the account and session.

## Requirements that apply everywhere

- **R7 Zero cost** Requirement: nothing billable is enabled, and a limit stops the service and never bills. Check: list the enabled plans and features at each milestone, and run a test that simulates each limit and sees a stop, not a charge. Phase 1 has no test for this requirement. A later phase must verify the real plan settings and show that each free limit stops the service without a charge. Fail: any billable item or a limit that bills.
- **R10 Clean public repo** Requirement: No secrets, codes, proofs or addresses reach the repo, logs or build output. Covers the working tree, the history from this work, build artifacts, build logs and source maps. Check: scans of all five for secrets, codes, proofs and email addresses, plus a manual read of the first pull request. Fail: any hit.

## Terms

- **Challenge** One sign-in attempt for one address, with its own random ID, code, and state.
- **Proof** Salutant's signed statement that the address was verified. It expires quickly. The app redeems it once.
- **App** A website or service that asks Salutant to verify an address. It is registered by its exact origin and exact callback URLs.
- **Allowlist** Addresses allowed to sign in. Only the owner changes the list.
- **Epoch** A number only the account owner can raise. Reject everything issued under an earlier number.
- **Owner** The person who owns the Salutant service accounts and the allowlist.

## Endpoints

- **POST /v1/challenges** Starts a sign-in. The local request contains the email address, app origin and sign-in state ID. The service creates the browser-binding value and returns it in a cookie. Behavior: creates one challenge for the address if the rules allow it, and asks the mail adapter to send the code. R2, R3, R5, R6, R8. The response is the same for an allowed and an unlisted address in status, headers, body and timing class (R3). It never waits for the mail provider.
- **POST /v1/challenges/{id}/verify** Checks a code. The challenge ID is in the path. The request body contains the code and email address; the cookie carries the browser-binding value. On success returns a signed proof once. A rejected code or challenge returns one generic error. Malformed bodies and internal failures use separate errors in the local implementation. A try is counted only for an attempt on an existing live challenge; an unknown, expired, or dead challenge counts nothing. R1, R2, R4.
- **GET /.well-known/jwks.json** Returns the public keys with their key ids, and the current epoch. Cacheable; the time is under App key cache. R12, R14.
- **GET /** The code-entry page, with its script and style files, served by the Salutant service. The local page requires a registered app origin in the app query parameter. R9, R16.
- **Everything else** Any other path returns a generic not-found response that still carries the required headers (R9). [Any method a path does not allow returns 405 Method Not Allowed with an Allow header and the same required headers.]
- **R3 No hints** Requirement: Responses and timing do not show whether an address is allowed. Check: compare responses byte for byte except the permitted fields; compare timing within the tolerance in the Timing protocol under Test hooks for Phase 1 (its bracketed values are proposals until measured); drive the limits for an allowed and an unlisted address and find no difference. Fail: any difference outside tolerance.

## Codes (R1, R2, R8)

- **Format, lifetime, wrong tries, resend, and active attempts** [S29–S33](decision-log.md#settled-choices) owns the approved values. [S13](decision-log.md#settled-choices) owns browser binding. [S39](decision-log.md#settled-choices) owns the cleanup deadline.
- **Source** Generate codes with the platform's cryptographically secure random function. Compare their hashes with a timing-safe comparison. The local implementation uses Web Crypto random values and its own comparison loop; this is not proof of cloud timing behavior.
- **Storage** Never store the code as readable text. Store only a keyed hash (HMAC), a fingerprint made from the app, purpose, challenge ID, and code. Keep its service secret outside the database.

- **Use** A correct, unexpired, unused code succeeds exactly once. Any later use fails.
- **Wrong tries** A correct code after the approved guess limit fails.
- **Resend** A resend replaces only that challenge's code and uses no extra slot. A send-budget refusal keeps the last delivered code; see [the implementation](../src/service.js).
- **Active challenges** A request over the approved cap gets the same generic message, sends no mail, and uses no send budget, but counts toward the request counter.
- **Binding** A random value held in the requesting browser binds the challenge. The email can be read on another device; enter its code in the browser that requested it.
- **Errors** Wrong, expired, used, and dead codes return the same generic error.
- **Atomicity** Check, update, and consume must finish in one synchronous step, with no wait between the check and write. Many simultaneous submissions of one correct code must give one success. The local model lives in [storage.js](../src/storage.js). Production is planned to use one SQLite-backed Durable Object, a Cloudflare object with private storage. No state change may span a wait for outside work.
- **R1 Code lifecycle** Requirement: A correct code works once. Wrong, expired and reused codes fail. Check: tests for correct, wrong, expired, reused and a correct code on the try after the limit, plus many simultaneous submits of one correct code with exactly one success. Fail: two successes, or a success after the limit.
- **R2 Code generation and binding** Requirement: Codes are random, stored only as a keyed hash (a one-way scramble made with a secret key), and bound to the browser that asked. Check: storage and log scan for plain codes, cross-challenge and cross-browser reuse tests, and parallel resend-versus-verify tests. Fail means any one of: a plain code in storage or logs; a correct code accepted for a different challenge or browser; the old and new code of one challenge both succeed; a code that did not come from the secure random function. The statistical test cannot prove the last one, so it is checked by reading the code for the secure random source, and rechecked for any later code. Cleanup follows S39; the [purge finding](findings/phase-1-findings.md#4-deleting-expired-records-r13-r6-e10) names the local limits.

## Proof (R4)

- **Algorithm** Use only Ed25519 (EdDSA), the selected signing algorithm. The app rejects any other algorithm or key type.
- **Claims** Issuer, audience, minimal subject, issued-at, not-before, expiry, key id, nonce, proof id, and epoch. The nonce carries the sign-in state. Salutant shares only the address the app needs.
- **Lifetime** [S37 and S38](decision-log.md#settled-choices) own expiry and clock tolerance. The local app also imposes a shorter exchange window; see [the callback finding](findings/phase-1-findings.md#2-returning-the-sign-in-result-to-the-app-r16).
- **Nonce** Bound to the transaction that started the sign-in.
- **App checks** Signature, key id, issuer, audience (its own origin), epoch, expiry and not-before, state, and the proof id against its redemption record in one atomic step. Then it creates its own session.
- **Replay** The app owns the redemption record: proof id, time, and the session created. Many parallel redemptions of one valid proof give exactly one session.
- **Salutant records** Challenge and proof issuance records: challenge id, address hash, attempts, state, epoch, and the proof id issued. Salutant never sees sessions.
- **R4 Signed proof and exchange** Requirement: A proof is valid once, for one app, until it expires. Check: tests for wrong issuer, wrong audience, expired, future, not-yet-valid, altered, other algorithm or key type, unknown key id, reused nonce, and many parallel redemptions of one valid proof. Fail: any invalid proof accepted, or a proof that passes all checks but cannot complete one session, or completes more than one.

## Keys and epoch (R12, R14, R15)

- **Signing key** Create outside the repository. Store as a service secret. Identify it with a key ID.
- **App key cache** Apps cache public keys for at most 5 minutes. The endpoint cache is 5 minutes. Both are adopted production settings (derivation decisions of October 15, 2026). [S28](decision-log.md#settled-choices) owns the emergency revoke bound. No layer holds a key longer than its own setting.
- **Fail closed** After its cached key expires, an app that cannot refresh rejects every proof. Good proofs may fail during an emergency revoke. That is accepted.
- **Routine rotation** Keep both keys available for at least the proof lifetime, clock-skew allowance, and end-to-end bound combined.
- **Epoch rule** A number the service reads and never writes. Only the account owner can raise it. Sign-in challenges, issued proofs, and app sessions carry it. Reject earlier-epoch items. If the epoch cannot be read the service stays closed. Production must stay closed after a restore until the owner raises the epoch. The local rehearsal simulates that closed state; automatic restore detection and cloud enforcement remain unproven. Apps must read the epoch with the public keys and drop earlier sessions. The local test invokes session cleanup explicitly. Trust boundary: the Cloudflare account owner.
- **Lost mailbox** The owner adds the new address to the allowlist, removes the old one, and raises the epoch. Apps drop sessions from before the new epoch. An allowlist change admits a new identity and does not move the old identity's account or links. Any transfer is a separate owner action.
- **R12 Key lifecycle** Requirement: Key rotation and emergency revoke stay inside the allowed window for apps still trusting an old key. Check: a rehearsed routine rotation, a rehearsed emergency revoke, a run with refresh unavailable, and tests of CDN or endpoint cache refill and epoch freshness against the bound. Fail: an old-key proof works past the end-to-end bound after revoke, or a proof is accepted when no valid unexpired cached key exists and refresh fails.
- **R14 State survives restore safely** Requirement: A restore does not bring back used codes, used proofs or revoked keys. Check: a rehearsed restore if available, with tests for a used code, a used proof, a restored revoked key id and a cleared lockout. Fail: any of those works again after a restore.
- **R15 Lost mailbox** Requirement: After the owner changes the address, the old identity's proofs and sessions fail. Check: after the steps, an old-identity proof and an old session are both rejected, and the new identity cannot see the old account. Fail: either works. Settled by the owner.

## Limits and values (R6, R8, R11, R13)

- **Send and request limits** [S34–S36](decision-log.md#settled-choices) owns the approved policy. [E5](evidence-record.md#platform-notes-and-their-evidence-limits) owns current provider quotas. Local defaults are in [service.js](../src/service.js).


- **Request body** At most [2 KB].
- **Source address** Production must read the host's trusted header, never a client-supplied value. The local prototype reads cf-connecting-ip from the supplied Request; cloud trust remains unproven.
- **Address-linked state** Holds only a hash made with its own secret key, separate from the code key. S39 sets the cleanup deadline. The local purge deletes eligible records only when called, so it does not guarantee that deadline. Single-use protection still needed is not removed early. Daily and monthly totals contain no address. The local prototype keeps them for two days and 32 days from creation, then deletes them when purge runs.
- **CPU margin** Each request fits the free per-request CPU limit with at least [20 percent] margin. Unproven until measured on the real platform.
- **Service logs** [S39](decision-log.md#settled-choices) owns retention. Logs contain time, event type, outcome, and a hashed source. Never codes, proofs, or email addresses. The local log array has no timed cleanup.
- **R6 Limits** Requirement: Send, request and body limits hold under concurrent load. Check: concurrent over-limit tests, an oversize-body test, a spoofed-header test, and a check that no address-linked state outlives its purge time and that the daily and monthly totals are deleted at their set ages. Fail: any limit exceeded or bypassed, or address-linked state kept past its life.
- **R8 Quota and lockout** Requirement: An attacker who fills the open sign-in slots can delay the owner. The attacker normally lacks the emailed code, and the owner's browser cannot use a code from a challenge the attacker created. Check: a code remains valid only in the browser that requested it. The owner cannot use a code from someone else's challenge and signs in with a new challenge once a slot frees. The attack test checks both the browser binding and that recovery path. This one experiment does not prove protection against a sustained hourly lockout; that residual risk stays for the owner-only trial. A bot check is a required addition before opening to anyone else (milestone 2).
- **R11 Fits free compute** Requirement: A full sign-in fits the free CPU limit with margin. Check: a prototype measured on the real platform in a later phase. Fail: any path over the limit or inside the margin. Unproven until measured.
- **R13 Logging** Requirement: Logs hold no codes, proofs or addresses. Check: scan test logs for codes, proofs and addresses, and read the provider and mailbox retention settings once and record them. Phase 1 gives mock evidence only; actual retention is read at the later mail phase. Fail: any hit, or a retention value not recorded.

## Failure behavior (R5)

- **Always closed** Storage failure, replay record unavailable, clock uncertainty, mail failure, a failed write when consuming a challenge, or a missing key: no proof, plain message.
- **Mail acceptance** Provider acceptance does not prove delivery and never produces a proof.
- **Send reservation** Before calling the mail provider, save a reservation: request ID, address hash, and counters. If saving fails, send nothing. If the send result is unknown, keep the reservation and count it against the budget.
- **No automatic retry** Do not automatically retry an uncertain send. Check it against the provider's send record.
- **Double submit** Requests with the same idempotency key, a client-chosen ID that marks a repeat, count as one. The local page does not yet supply that key; double-click protection remains open.
- **Person sees** The local page shows the same generic message after each request. A cooldown message and resend control remain to be built.
- **R5 Closed on failure** Requirement: Any failure signs nobody in. Check: failure injection for each case, double-submit and provider-timeout tests, and a crash between the reservation and the send. Fail: a proof is issued from a send acceptance, an uncertain send is retried with no record, or two requests with the same idempotency key make two sends.

## Browser and callback protocol (R16)

- **Origins** Use an exact list of full origins. No wildcards or sibling origins. Access-Control-Allow-Origin names that one exact origin, never a star.
- **Callbacks** Each app registers exact callback URLs on its own origin. Match the full URL. Refuse lookalikes and external redirects.
- **Return path** The code page sends the proof to the exact registered app callback. The browser then loads the app's completion page, which ties the proof to that browser. No proof or token is in a URL.
- **State** The app keeps random state in a server-side pending record. The state travels in the request body and in the signed proof's nonce claim. The local prototype binds completion to the browser using its first-party pre-auth cookie; attacker-owned state or proof cannot complete a different browser session in the mock tests.
- **Cookies** Host-only, Secure, and HttpOnly, with no domain attribute. The challenge-binding cookie is SameSite=Strict. The app pre-auth cookie is SameSite=Lax so it travels on the top-level completion step. No third-party cookie is used in the local prototype.
- **No tokens in URLs** No tokens, codes, or proofs in URLs, referrers, or logs.
- **Session** Lifetime and logout belong to the app.
- **R16 Browser protocol** Requirement: Wrong origins, altered state and lookalike callbacks are refused. Check: tests with a wrong origin, a sibling origin, altered state, a lookalike callback, and an external redirect, plus a Safari run with third-party cookies blocked. Fail: an invalid input is accepted, or sign-in fails with third-party cookies blocked. Cloudflare hosts the planned code page; Phase 1 remains local.

## Response headers (R9)

- **Every response the service generates** Content-Security-Policy with default-src none, script-src self, style-src self, connect-src self plus the exact registered app origin, img-src self, base-uri none, frame-ancestors none, and form-action none. X-Frame-Options DENY. X-Content-Type-Options nosniff. Referrer-Policy no-referrer. Strict-Transport-Security max-age 31536000. Permissions-Policy denying camera, microphone and geolocation. Cross-Origin-Opener-Policy same-origin. Cache-Control no-store on sign-in and proof responses.
- **Where set** In code, on every generated response: success, error, redirect, not-found and callback. A static header file does not cover generated responses.
- **R9 Response headers** Requirement: Every response carries the required security headers. Check: real requests using each route's allowed method, saved as evidence, plus a CI check. Fail: any response lacks them.

## Mail adapter (provider-neutral)

- **Interface and content** The [Mail Adapter Contract](mail/mock-mail-adapter-contract.md) owns operations, result names, reservations, generic subjects, and tracking limits.

- **Retention** See [provider retention](evidence-record.md#platform-notes-and-their-evidence-limits), E5. A code expiring does not delete the email from the recipient's mailbox.
- **Provider choice** [S27](decision-log.md#settled-choices) owns the selected mail path. Recheck free-plan terms before any account, credential, or send.
- **Credentials** Use a secure vault link only. Never put credentials in chat, the repository, or logs.

## Test hooks for Phase 1

- **Mock service** The service logic runs locally with a controllable clock, mock mail, injected storage failures and a settable epoch. Random values come from Web Crypto; the test harness does not control them.
- **Stub app** A small app in the test suite that registers an origin and callback, redeems proofs with its own store, and is used for replay, wrong-origin, stale-key, epoch and cross-site tests. No real app is touched.
- **Required tests** Concurrency (one success from many submits), replay, restore, headers on every route type, timing, failure injection, double-submit, provider timeout, oversize body, spoofed source header, wrong origin, sibling origin, altered state, lookalike callback, and cross-site login with attacker-owned state.
- **Timing protocol** Local test harness only, mail stubbed. [200] interleaved requests per class (allowed and unlisted) in [3] separate runs. Tolerance is the larger of [20 ms] and the run-to-run difference within one class, with a hard maximum of [50 ms]. Over the maximum fails. Inconclusive results are rerun once and reported as they stand.
- **Limits of local tests** Local timing does not prove the platform CPU limit. A local restore does not prove cloud recovery. Both, and real response headers, are rechecked in a later cloud phase. A local pass on them is recorded as local only, never as a PASS for the real platform.

## Quotas

- **Account** Cloudflare free plan only, with no payment method. The owner confirms this before any setup; if it is not on the free plan, setup stops.
- **Shared budget** Free limits cover the whole account, not each object. Other account use and purge work count against the same budgets.
- **Re-check** Costs are re-read at each milestone. Platform facts and their sources are in the Evidence Record (docs/evidence-record.md).

## Open items

- **1** Epoch mechanism: Phase 1 gives a local mock and a written design finding. Read consistency and cache behavior on the real platform can only be proven in a later cloud phase.
- **2** Final production values for the request body limit, CPU margin, and timing protocol remain bracketed proposals. The production exchange and completion windows also remain open; the local callback uses 60 seconds for each, as recorded in finding 2. A local value is not an approved production value.
- **3** Host records and certificates for salutant.soliskit.com and mail.soliskit.com, recorded when the hosts exist.
- **4** Production request and response fields. Phase 1 has concrete fields and status codes in [service.js](../src/service.js); adopting the production contract remains open. No field may reveal whether the address is allowed (R3).
- **5** Production timing values and the owner's review of the measured values, in the later phases.
- **6** Bot-check design before opening to others; see S22.
- **7** Local page resend controls and idempotency keys, real log cleanup, and automatic purge scheduling remain unbuilt. See the [Evidence Record](evidence-record.md).
