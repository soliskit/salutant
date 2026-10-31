# Salutant Evidence Record

The evidence this project relies on: checks of the project's own behavior, and outside facts from providers and standards. Each entry has its source, the date checked, a status, and its limits. A local result never closes a real-platform check, and only Verified facts support a requirement.

Statuses:

- Verified - established against its source on the recorded date. For a fact, the source was read. For a check, a result was recorded at a named commit on the stated platform.
- Unproven - evidence exists but does not establish the claim (conflicting, stale, or unreadable sources). An Unproven entry cannot support a requirement.
- Pending - no closing result yet. Where a local or partial result exists, the entry states the local result and the real-platform result separately.

Entries keep their original check dates; nothing was rechecked or rerun for this reformat.

## Checks

The rows link to tests. On October 12, 2026, a local run at main 7258b0e882d07a18b144d61b1371bd15e7dbfc74 passed all 80 tests with Node v22.23.3. This is local evidence, not a cloud result. Missing checks and local limits remain explicit. Real-platform results are Pending; the earlier independent review is not tied to a specific commit in this record.

A completed result needs evidence: a test run at an exact commit, a saved response, or a reviewer verdict. A merge alone does not show that tests passed. Acceptance checks are defined in [requirements.md](requirements.md). [Requirements](requirements.md#terms) defines proof, challenge, and epoch.

- **R1 Code lifecycle.** Local: [tests/lifecycle.test.js](../tests/lifecycle.test.js). Real platform: Pending.
- **R2 Code generation and binding.** Local: [tests/lifecycle.test.js](../tests/lifecycle.test.js). Real platform: Pending. Bounded: covers hashed storage, binding to the challenge and the browser, and resends. The secure random source is not tested; it is checked by reading the code.
- **R3 No hints.** Local: [tests/no-hints.test.js](../tests/no-hints.test.js). Real platform: Pending.
- **R4 Signed proof and exchange.** Local: [tests/proof-exchange.test.js](../tests/proof-exchange.test.js). Real platform: Pending.
- **R5 Closed on failure.** Local: [tests/failure-modes.test.js](../tests/failure-modes.test.js). Real platform: Pending. Bounded: does not cover a crash between the reservation and the send.
- **R6 Limits.** Local: [tests/limits.test.js](../tests/limits.test.js). Real platform: Pending.
- **R7 Zero cost.** Local: no local test exists. Real platform: Pending.
- **R8 Quota and lockout.** Local: [tests/limits.test.js](../tests/limits.test.js). Real platform: Pending.
- **R9 Response headers.** Local: [tests/headers.test.js](../tests/headers.test.js). Real platform: Pending.
- **R10 Clean public repo.** Local: [tests/logging-hygiene.test.js](../tests/logging-hygiene.test.js). Real platform: Pending. Bounded: scans the working tree only. History, build artifacts, build logs, source maps and the first pull request read are not covered.
- **R11 Fits free compute.** Local: [scripts/bench.js](../scripts/bench.js), an older run summarized in [findings](audit/phase-1-findings.md) item 6. Real platform: Pending. A local run cannot prove it.
- **R12 Key lifecycle.** Local: [tests/restore-epoch.test.js](../tests/restore-epoch.test.js). Real platform: Pending. Bounded: a local rehearsal with an injected key cache. No real content delivery network or key endpoint cache is involved.
- **R13 Logging.** Local: [tests/logging-hygiene.test.js](../tests/logging-hygiene.test.js). Real platform: Pending. The in-memory log array has no retention cleanup; see [the source finding](audit/phase-1-findings.md#service-log-cleanup).
- **R14 State survives restore.** Local: [tests/restore-epoch.test.js](../tests/restore-epoch.test.js). Real platform: Pending. Bounded: covers the restore rehearsal and a restored used code. A used proof, a revoked key id and a cleared lockout are not each tested.
- **R15 Lost mailbox.** Local: [tests/restore-epoch.test.js](../tests/restore-epoch.test.js). Real platform: Pending. Bounded: covers that an earlier-epoch proof and session are rejected. That the new identity cannot see the old account is not tested.
- **R16 Browser protocol.** Local: [tests/browser-protocol.test.js](../tests/browser-protocol.test.js). Real platform: Pending.

### Phase 1 exit evidence

- **Mock service and stub app** Local and mock prototype, merged in [PR 59](https://github.com/soliskit/salutant/pull/59). It uses no real mail, deployment or accounts. The PR body is historical and does not give the current test count.
- **Concurrency, replay, restore, header, and timing tests** CI runs `npm test` on every push ([test.yml](../.github/workflows/test.yml)): The suite covers concurrency, replay, restore, headers, timing, and failure injection. The October 12 local run is recorded above. The timing and CPU summary in [findings](audit/phase-1-findings.md) item 6 comes from an older run (October 7, Node 22, tree b9f9b61), not from the October 12 run. The historical tree identifier is retained as reported; it is not a current-main reference.
- **Findings on production mechanisms** [Written local findings](https://github.com/soliskit/salutant/blob/main/docs/audit/phase-1-findings.md) cover the restore epoch, the callback, the key cache and the purge. Cloud behavior and real Safari are still open. The findings have no linked independent test run at a specific commit. This record does not independently verify them.
- **Measured values and open decisions** An older run's timing and CPU outcome is summarized in the findings file, item 6; the figures stay in git history. The approved emergency key window lives in [Keys and epoch](requirements.md#keys-and-epoch-r12-r14-r15), pending cloud proof. Real-platform measurements are still open. Local CPU results do not prove the Workers CPU limit.

## Facts

Each outside fact carries its source, the date checked, and a status of Verified or Unproven. Only Verified facts support a requirement. Primary sources below were reread October 21, 2026 (first read October 12, 2026). These are provider terms, not proof of this service's configuration.

E6 and E9 are unused numbers, kept so cited E-numbers stay stable.

- **E1 Free request cap** Workers Free: 100,000 requests per day, resetting at midnight UTC. Verified October 21, 2026: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- **E2 Free CPU cap** Workers Free: 10 ms CPU per HTTP request. Waiting on network requests does not count toward CPU time. Verified October 21, 2026, at the same page.
- **E3 Pages and headers** Verified October 21, 2026. Samples: HEAD requests to https://soliskit.github.io/ on October 7, 2026 and October 21, 2026 each returned server GitHub.com and access-control-allow-origin *, and no X-Frame-Options, Content-Security-Policy, or Strict-Transport-Security. One sample is not proof for every response, and no way to set headers on Pages was found. Also verified at https://developers.cloudflare.com/workers/static-assets/headers/ on October 21, 2026: custom headers defined in the `_headers` file are not applied to responses generated by Worker code, even when the request URL matches a rule, and headers for those must be sent from the Worker's own response.
- **E4 Pages terms** Verified October 21, 2026. "GitHub Pages sites shouldn't be used for sensitive transactions like sending passwords or credit card numbers." Also not for running a business, e-commerce site, or commercial software as a service. [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- **E5 Mail provider quota.** Verified October 21, 2026. Resend is the selected provider (see [Mail adapter (provider-neutral)](requirements.md#mail-adapter-provider-neutral)). https://resend.com/pricing : Free is 100 emails a day and 3,000 a month. The approved policy in [Limits and values](requirements.md#limits-and-values-r6-r8-r11-r13) limits sign-in mail to 90% of the available free allowance, currently 90 a day and 2,700 a month before other account mail. https://resend.com/docs/knowledge-base/account-quotas-and-limits (Free Account Quotas and Limits): "daily email quota of 100 emails/day and 3,000 emails/month"; "This quota includes both sent and received emails"; "Multiple `To`, `CC`, or `BCC` recipients in sent emails count as separate emails towards this quota"; the daily quota is a UTC calendar day that "resets at midnight UTC". Checked October 21, 2026 at the same page (Data Retention): Resend keeps email content and metadata, delivery status and events, logs and metrics for 30 days on Free, Pro and Scale plans.
- **E7 Actions cost** Standard GitHub-hosted runner usage is free for public repos. Larger runners are paid; this is not a blanket zero-cost claim for every Actions feature. Verified October 21, 2026: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
- **E8 Other free-tier terms** Unproven. As of October 21, 2026: this service's compliance with Cloudflare storage limits remains unproven. Bot-challenge terms, plan terms beyond the verified entries, and trusted source-address header behavior also remain unproven.
- **E10 Durable Objects on Free** Verified October 21, 2026. https://developers.cloudflare.com/durable-objects/platform/pricing/ : available on Workers Free with the SQLite backend only; free limits 100,000 requests per day, 5 million rows read per day, 100,000 rows written per day, 5 GB stored; past any free limit, further operations of that type fail with an error, and daily free limits reset at 00:00 UTC. Duration 13,000 GB-s per day. Point-in-time recovery restores a Durable Object's embedded SQLite database contents to any point in the past 30 days (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). An alarm invocation is billed as a request, and each setAlarm is billed as a single row written. https://developers.cloudflare.com/durable-objects/platform/limits/ : 5 GB per account on Free, with a 1 GB limit per SQLite-backed object on Free (10 GB on paid); writes past the object limit fail with a storage-full error. https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/ : each object's attached storage is private to its instance, and each method is implicitly wrapped in a transaction, atomic and isolated from other storage operations.
- **E11 Worker crypto** Verified October 21, 2026. https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ : Ed25519, HMAC (a keyed hash), secure random values (getRandomValues), and a timing-safe comparison (timingSafeEqual) are available in Workers.
- **E12 Sending subdomain** Verified October 21, 2026. https://resend.com/docs/dashboard/domains/introduction : Resend recommends sending from a subdomain, and allows several verified subdomains of one domain. Planned service settings: a subdomain used only for these emails, not the root domain or a web-page name, with no existing mail records; a no-reply From address; open and click tracking off. No provider account exists, so these settings are not verified configuration.
