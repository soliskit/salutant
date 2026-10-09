# Salutant Decision Log

**Status.** Entries record the decision, its effect and its status. Where a choice changed, the old entry stays and says what replaced it. This log is a supporting record kept in the repo next to the code.

## How this log works

Each entry records a choice the owner made: the decision, its effect and its status. Message IDs, times and verbatim quotes are not kept here, because this repo is public and discloses only what is necessary. The proof of each decision is kept in the owner's private record. Work does not reopen a settled entry. A change is a new entry that says which entry it replaces. Recommendations the owner has not approved are listed separately at the end. The current Playbook has three tabs: Charter, Roadmap and How It Works. This log and the Evidence Record live with the code.


## Settled choices

- **S1 Free is required** Effect: no paid plan or feature; a free limit stops the service and never bills. Status: Settled.
- **S2 Hosting order** GitHub when possible, then Cloudflare, then Vercel, for every software project. Status: Settled.
- **S3 Build our own email sign-in** Effect: Salutant exists. The six-digit code form is a recommendation, not the owner's words, and stays a proposal until approved. Status: Settled for the idea; the code format is settled by S29.
- **S4 Separate repo** Salutant has its own repo and does not pollute another project's repo. It did not approve replacing the repo's contents; decision S7 did. Status: Settled.
- **S5 Documentation-only merges** Effect: documentation-only merges are pre-approved for all software projects. It does not cover code, tests, CI or releases. Status: Settled, scope documentation only.
- **S6 Plan template for all software projects** Effect: every software project gets a plan in the same form. Status: Settled.
- **S7 1 Replace the repo's contents** Effect: the old Swift form-message app goes; its history stays in git; at that time nothing changed until the build go-ahead. Status: Settled; the Phase 1 go-ahead was later given (see the entry Phase 1 code started).
- **S8 Mail path, first choice** Effect: the Resend free plan sending from a subdomain of the owner's own domain. Replaced by S9. Status: Replaced.
- **S9 2a Mail path, second choice** Effect: iCloud first, Resend fallback. Apple's terms explicitly restrict automated access in the quoted interference clause, and application to this service was unresolved. Status: Replaced by entry 2b.
- **S10 2b Mail path, third choice** Effect: a dedicated Gmail account is the selected sender for this service, for now; iCloud dropped; Resend on a subdomain stays the fallback. Account creation, any credential and any send are later phases, each authorized separately. Google terms and limits for automated sending are researched first. The mail adapter stays provider-neutral. Replaced by S27. Status: Replaced.
- **S11 Phase 1 plan approved** Effect: the Phase 1 plan is adopted for Phase 1 only: code on a branch in the salutant repo, using fakes. No accounts, no domain setup, no real emails, no launch. This approval is not the go-ahead to write code. Status: Settled.
- **S12 Phase 1 code started** Effect: local and mock work started on a branch with a pull request; nothing merges without the owner. It approves no accounts, real mail, cloud tests, connecting an app, merge, release or later phases. Status: Settled.
- **S13 Browser binding kept** Effect: browser binding of each sign-in challenge stays in the Phase 1 design. The challenge is bound to the browser that asked, by a random value held in that browser, and the emailed code works only when entered in that browser. An intercepted email alone is insufficient to complete the browser-bound sign-in. The cost: asking on one device and entering the code on another fails and must be retried. Design choice only; it approves no merge, account, real mail, cloud work or later phase. The Specification wording on browser binding was aligned with this entry after the decision; this entry governs the decision status. This log does not adopt any other unresolved Specification value. Status: Settled.
- **S14 Merge of Phase 1 pull request** Effect: the Phase 1 local and mock pull request (pull request 59) may be merged at head 5224e6076ce064ee35c8c72e5f8149a88e55ce90. That head is the reviewed commit 59f44506b92f171666199bf2e0675b59beac183a plus one documentation commit recording the browser binding decision, pushed before this approval. Scope: Phase 1 local and mock code only. It does not approve accounts, real mail, cloud work, deployment, connecting an app, release or any later phase. Status: Settled. The subsequent merge is recorded in S15.
- **S15 Phase 1 pull request merged** Recorded fact, not a new approval. Pull request 59 was merged to main as squash commit 8bd88447aa47af3c5421b2f23166cdc7b532f5fa. Its tree is identical to the approved head 5224e6076ce064ee35c8c72e5f8149a88e55ce90, as reported by the coordinating agent. It was done under the merge approval recorded above. Nothing further is approved: accounts, real mail, cloud work, deployment, connecting an app, release and later phases each still need their own authorization. Status: Done.
- **S16 3 Who can sign in** Effect: an approved list only, starting with the owner's address; people are added only by the owner's say-so. Status: Settled.
- **S17 4 One app or many** Effect: one service that can serve many apps; a first app is connected first. Status: Settled.
- **S18 5 Where the code page lives** Effect: the code-entry page is on Cloudflare; public pages are on GitHub Pages. The claim that GitHub Pages cannot block framing was a statement in the question and is supported only by sampled-header evidence. Status: Settled.
- **S19 6 Lost mailbox** Effect: no shortcut in the sign-in; the owner fixes it by changing the approved address in the service settings, using the owner's own account access. Status: Settled.
- **S20 7 Runtime and storage** Effect: a Cloudflare Worker with its built-in free storage for codes and limits; the restore safety switch (the epoch) is a separate setting only the owner can change. The mechanism for the epoch is Open. Status: Settled; epoch mechanism Open.
- **S21 8 Trial recipients** Effect: trial emails go only to the owner's own address. Status: Settled.
- **S22 9 Lockout residual** Effect: the owner accepts that someone who knows the owner's address can delay the owner for up to an hour at a time, for the owner-only trial; a bot check is added before Salutant opens to anyone else. The up-to-an-hour delay is replaced by S33; the bot-check condition stands. Status: Settled.
- **S23 Document set approved** Effect: Specification, Decision Log and Evidence Record, with the Charter and Build Plan. Status: Settled.
- **S24 Specification split out; old drafts deleted** Effect: the Specification is its own document; superseded documents were removed. Status: Done.
- **S25 Playbook for the project** Effect: Salutant gets the Playbook first (named Blueprint when chosen, renamed Playbook on 7 October). Delete only fully superseded documents after replacement content is reviewed and committed to git. Status: Settled; deletions pending review.
- **S26 Playbook** Effect: the three files Charter, Build Plan and Specification together are called the Playbook (named Blueprint when chosen, renamed Playbook on 7 October), and it is the standard set for every software project. Status: Settled.

- **S27 Mail path, current** Effect: sign-in mail goes through Resend from mail.soliskit.com, replacing the dedicated Gmail account in S10; iCloud stays dropped. Account creation, domain setup, credentials and real sends remain later-phase work, each authorized separately. The mail adapter stays provider-neutral. Provider limits and delivery remain to be checked before real sends. Status: Settled for the mail path; real sending unproven.

- **S28 Emergency revoke window** Effect: after an emergency signing-key revoke, apps stop trusting the old key within at most 10 minutes. The owner accepts this as a hard maximum for the owner-only trial, on the condition that cloud tests prove it. This sets the safety limit only; it is not a go-live, and it settles the emergency key staleness question below. Status: Settled as a limit; cloud proof pending.
- **S29 Six-digit code format** Effect: the sign-in code is six digits, with limits on wrong guesses. This settles the code format left open in S3 and approves the recommendation listed below. Format only; it approves no real emails and no go-live. Status: Settled.
- **S30 Code lifetime** Effect: a sign-in code expires after 30 minutes, works once and only in the browser that asked for it. Lifetime value only; this replaces the proposed [10 minutes] value. Status: Settled.
- **S31 Wrong-guess limit** Effect: five wrong guesses cancel a sign-in code; signing in then needs a new code. Per-code limit only. Status: Settled.
- **S32 Resend wait** Effect: a resend can be asked for only after a one-minute wait; a resend replaces the old code for that attempt. Wait only. Status: Settled.
- **S33 Two unfinished attempts** Effect: at most two unfinished sign-in attempts for the owner's address at once. A slot frees when its code is used, cancelled by five wrong guesses or expires. An outsider who fills both slots can delay the owner by up to 30 minutes; the owner accepts that for the owner-only trial, replacing the up-to-an-hour delay accepted in S22. Status: Settled.
- **S34 Three emails per 30 minutes** Effect: at most three sign-in emails to one address per 30 minutes, including resends; once used up, the address waits for the window to reset. An outsider can use up the allowance and delay the owner; the owner accepts that for the owner-only trial. This entry claims no provider quota. Status: Settled.
- **S35 Ninety percent of the free mail allowance** Effect: sign-in mail uses at most 90% of the mail provider's current free allowance (90 emails a day and 2,700 a month at the provider's free plan of 100 a day and 3,000 a month, checked 9 October 2026); the service stops rather than pays. Other mail on the same account reduces the allowance. The three-per-address limit in S34 stays. Policy only; no account and no real mail is authorized. Status: Settled.

## Carried over from the removed duplicate log

These two entries come from `docs/decisions/decision-log.md`, removed as a duplicate. They are historical records, not new decisions. Source: that file in git history before the removal. Status for both: Settled.

- **One app or many** One service that can serve many apps. The first connected app is the owner's video-call app. Historical record; the owner decision of 7 October 2026, as recorded in the removed log.
- **Browser binding stays** A sign-in code verifies only from the browser that requested it, so a phished or observed code is useless elsewhere. The accepted cost: under a slot-filling attack a code mailed from an attacker's challenge cannot be used in the owner's own browser - the owner is delayed until a slot frees, never locked out (finding 5). (Owner decision 7 October 2026, answering the phase 1 finding-5 question: "Keep it".) Historical record; S13 above is the entry that governs the browser binding decision.

## Open decisions

- **Final contract values** Every bracketed value in How It Works returns for the owner's approval with the plan.
- **Cloud epoch mechanism** The local findings report a passing injected-source restore rehearsal. A Worker environment variable is a candidate only; propagation to all running copies and stale reads still need cloud testing.
- **Real-browser callback behavior** The local findings and test report record option 2 script exchange and first-party completion passing mock tests. Real Safari behavior remains unverified.
- **Production timing and owner review** The committed report records local timing passing the written protocol. Production timing and Workers CPU remain unmeasured; the owner reviews the measured values before any launch.
- **Phase approval** Approval of the Roadmap covers Phase 1 (local code and mocks) only. Historical: a separate code go-ahead was required, and was later given for Phase 1 only (see the entry Phase 1 code started). Merge and every later phase are not covered and need their own authorization.

## Local findings already reported

These are summaries of reported local results, not new owner decisions, a new test execution or authorization for a later phase. Sources: [local findings](findings/phase-1-findings.md) and [committed test report](evidence/phase-1-test-results.md). The test report names commit `b9f9b61ff189b98115ff2cb46d1f7bd164681949`; this log does not independently bind a run to that commit or establish current-main test results.

- **Epoch design** Finding 1 reports that every challenge, issuance, proof and app session carries the epoch, earlier epochs are rejected and an unreadable injected epoch source fails closed. The R14/R12/R15 test-report section records a restore rehearsal staying closed until an owner epoch raise, then rejecting pre-raise codes and proofs. Cloud propagation and restore behavior remain open above.
- **Callback return path** Finding 2 reports option 2 was built and passed the mock login-CSRF check: bounded script exchange to the exact app callback, followed by top-level completion using the app's first-party SameSite=Lax pre-auth cookie. Option 1 was rejected by protocol analysis and was never built. The R16 test-report section records first-party cookie checks and mock login-CSRF rejection; the service challenge-binding cookie remains SameSite=Strict. Real Safari behavior remains open above.
- **Timing evidence** The test report's R3 timing section records passes in all three local runs with a 20 ms tolerance and 50 ms hard maximum. Its separate R11 full-sign-in CPU sample records a 2.90 ms median and 65.40 ms cold-run maximum; it does not prove the Workers 10 ms free CPU limit. Production measurements and owner review remain open above.

## Recommendations not approved

- **Bot check before opening to others** The owner accepted that it is added before opening (S22); its design is not chosen.
