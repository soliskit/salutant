# Salutant Decision Log

**Status.** Entries record the decision, its effect, and its status. Where a choice changed, the old entry stays and says what replaced it. This log is a supporting record kept in the repo next to the code.

## How this log works

Each entry records a choice the owner made: the decision, its effect, and its status. Message IDs, times, and verbatim quotes are not kept here, because this repo is public and discloses only what is necessary. The proof of each decision is kept in the owner's private record. Work does not reopen a settled entry. A change is a new entry that says which entry it replaces. Recommendations the owner has not approved are listed separately at the end. The current Playbook has three tabs: Charter, Roadmap, and How It Works. This log and the Evidence Record live with the code.

## Settled choices

- **S1 Free is required** Effect: no paid plan or feature; a free limit stops the service and never bills. Status: Settled.
- **S2 Hosting order** GitHub when possible, then Cloudflare, then Vercel, for every software project. Status: Settled.
- **S3 Build our own email sign-in** Effect: Salutant exists. The six-digit code form is a recommendation, not the owner's words, and stays a proposal until approved. Status: Settled for the idea; the code format is settled by S29.
- **S4 Separate repo** Salutant has its own repo and does not pollute another project's repo. It did not approve replacing the repo's contents; decision S7 did. Status: Settled.
- **S5 Documentation-only merges** Effect: documentation-only merges are pre-approved for all software projects. It does not cover code, tests, CI, or releases. Status: Settled, scope documentation only.
- **S6 Plan template for all software projects** Effect: every software project gets a plan in the same form. Status: Settled.
- **S7 1 Replace the repo's contents** Effect: the old Swift form-message app goes; its history stays in git; at that time nothing changed until the build go-ahead. Status: Settled; the Phase 1 go-ahead was later given (see the entry Phase 1 code started).
- **S11 Phase 1 plan approved** Effect: the Phase 1 plan is adopted for Phase 1 only: code on a branch in the salutant repo, using fakes. No accounts, no domain setup, no real emails, no launch. This approval is not the go-ahead to write code. Status: Settled.
- **S12 Phase 1 code started** Effect: local and mock work started on a branch with a pull request; nothing merges without the owner. It approves no accounts, real mail, cloud tests, connecting an app, merge, release, or later phases. Status: Settled.
- **S13 Browser binding kept** Effect: browser binding of each sign-in challenge stays in the Phase 1 design. The challenge is bound to the browser that asked, by a random value held in that browser, and the emailed code works only when entered in that browser. An intercepted email alone is insufficient to complete the browser-bound sign-in. The cost: asking on one device and entering the code on another fails and must be retried. Design choice only; it approves no merge, account, real mail, cloud work, or later phase. The Specification wording on browser binding was aligned with this entry after the decision; this entry governs the decision status. This log does not adopt any other unresolved Specification value. Status: Settled.
- **S14 Phase 1 pull request merged** Effect: the Phase 1 local and mock pull request (pull request 59) was approved for merge at its reviewed head and merged to main. Scope: Phase 1 local and mock code only. It does not approve accounts, real mail, cloud work, deployment, connecting an app, release, or any later phase; each still needs its own authorization. Status: Done.
- **S16 3 Who can sign in** Effect: an approved list only, starting with the owner's address; people are added only by the owner's say-so. Status: Settled.
- **S17 4 One app or many** Effect: one service that can serve many apps; a first app is connected first. Status: Settled.
- **S18 5 Where the code page lives** Effect: the code-entry page is on Cloudflare; public pages are on GitHub Pages. The claim that GitHub Pages cannot block framing was a statement in the question and is supported only by sampled-header evidence. Status: Settled.
- **S19 6 Lost mailbox** Effect: no shortcut in the sign-in; the owner fixes it by changing the approved address in the service settings, using the owner's own account access. Status: Settled.
- **S20 7 Runtime and storage** Effect: a Cloudflare Worker with its built-in free storage for codes and limits; the restore safety switch (the epoch) is a separate setting only the owner can change. The mechanism for the epoch is Open. Status: Settled; epoch mechanism Open.
- **S21 8 Trial recipients** Effect: trial emails go only to the owner's own address. Status: Settled.
- **S22 9 Lockout residual** Effect: the owner accepts that someone who knows the owner's address can delay the owner for up to an hour at a time, for the owner-only trial; a bot check is added before Salutant opens to anyone else. The up-to-an-hour delay is replaced by S33; the bot-check condition stands. Status: Settled.
- **S23 Playbook** Effect: the Playbook is the project's one plan: Charter, Roadmap and How It Works. The older drafts were deleted. It is the standard set for every software project. Status: Settled.

- **S27 Mail path, current** Effect: sign-in mail goes through Resend from mail.soliskit.com, replacing the dedicated Gmail account in S10; iCloud stays dropped. Account creation, domain setup, credentials, and real sends remain later-phase work, each authorized separately. The mail adapter stays provider-neutral. Provider limits and delivery remain to be checked before real sends. Status: Settled for the mail path; real sending unproven.

- **S28 Emergency revoke window** Effect: after an emergency signing-key revoke, apps stop trusting the old key within at most 10 minutes. The owner accepts this as a hard maximum for the owner-only trial, on the condition that cloud tests prove it. This sets the safety limit only; it is not a go-live, and it settles the emergency key staleness question below. Status: Settled as a limit; cloud proof pending.
- **S29 Six-digit code format** Effect: the sign-in code is six digits, with limits on wrong guesses. This settles the code format left open in S3 and approves the recommendation listed below. Format only; it approves no real emails and no go-live. Status: Settled.
- **S30 Code lifetime** Effect: a sign-in code expires after 30 minutes, works once and only in the browser that asked for it. Lifetime value only; this replaces the proposed [10 minutes] value. Status: Settled.
- **S31 Wrong-guess limit** Effect: five wrong guesses cancel a sign-in code; signing in then needs a new code. Per-code limit only. Status: Settled.
- **S32 Resend wait** Effect: a resend can be asked for only after a one-minute wait; a resend replaces the old code for that attempt. Wait only. Status: Settled.
- **S33 Two unfinished attempts** Effect: at most two unfinished sign-in attempts for the owner's address at once. A slot frees when its code is used, cancelled by five wrong guesses, or expires. An outsider who fills both slots can delay the owner by up to 30 minutes; the owner accepts that for the owner-only trial, replacing the up-to-an-hour delay accepted in S22. Status: Settled.
- **S34 Three emails per 30 minutes** Effect: at most three sign-in emails to one address per 30 minutes, including resends; once used up, the address waits for the window to reset. An outsider can use up the allowance and delay the owner; the owner accepts that for the owner-only trial. This entry claims no provider quota. Status: Settled.
- **S35 Ninety percent of the free mail allowance** Effect: sign-in mail uses at most 90% of the mail provider's current free allowance (90 emails a day and 2,700 a month at the provider's free plan of 100 a day and 3,000 a month, checked 9 October 2026); the service stops rather than pays. Other mail on the same account reduces the allowance. The three-per-address limit in S34 stays. Policy only; no account and no real mail is authorized. Status: Settled.
- **S36 Ten requests per hour** Effect: at most 10 sign-in requests per hour for one email address and 10 per hour for one internet address; extra requests wait until the window resets. This limit is separate from the email-send allowance in S35. A shared internet address can block a real retry; the owner accepts that for the owner-only trial and revisits it before opening to others. Policy only. Status: Settled.
- **S37 Five-minute proof** Effect: the one-time sign-in proof expires after five minutes and works once; an expired proof does not sign the owner out, and the app manages the session separately. Clock-skew tolerance stays a separate proposal. Status: Settled.
- **S38 One-minute clock tolerance** Effect: a one-minute clock difference is allowed when checking the five-minute proof, so a proof may be accepted up to one minute past expiry, about six minutes in total. This does not change the email code lifetime (S30) or the key-revoke limit (S28). It settles the clock-skew tolerance left as a proposal in S37. Status: Settled.
- **S39 Record keeping** Effect: expired sign-in attempts and address-linked limits are deleted within 24 hours; the service's own basic event logs are kept 14 days; logs never contain email addresses, codes, or proofs. This covers the service's own records only, not the mail provider's 30-day copy or cloud backups. Single-use protection that is still needed is not removed early. Status: Settled.

## Open decisions

Open items are kept in one place: the Open items list in the Playbook (How It Works tab).

## Recommendations not approved

- **Bot check before opening to others** The owner accepted that it is added before opening (S22); its design is not chosen.
