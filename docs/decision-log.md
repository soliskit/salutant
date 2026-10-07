# Salutant Decision Log

**Status.** Entries record the decision, its effect and its status. Where a choice changed, the old entry stays and says what replaced it. This log is a supporting record kept in the repo next to the code.

## How this log works

Each entry records a choice the owner made: the decision, its effect and its status. Message IDs, times and verbatim quotes are not kept here, because this repo is public and discloses only what is necessary. The proof of each decision is kept in the owner's private record. Work does not reopen a settled entry. A change is a new entry that says which entry it replaces. Recommendations the owner has not approved are listed separately at the end. The Playbook is three files: Charter, Build Plan and Specification. This log and the Evidence Record live with the code.


## Settled choices

- **S1 Free is required** Effect: no paid plan or feature; a free limit stops the service and never bills. Status: Settled.
- **S2 Hosting order** GitHub when possible, then Cloudflare, then Vercel, for every software project. Status: Settled.
- **S3 Build our own email sign-in** Effect: Salutant exists. The six-digit code form is a recommendation, not the owner's words, and stays a proposal until approved. Status: Settled for the idea; code format Open.
- **S4 Separate repo** Salutant has its own repo and does not pollute another project's repo. It did not approve replacing the repo's contents; decision S7 did. Status: Settled.
- **S5 Documentation-only merges** Effect: documentation-only merges are pre-approved for all software projects. It does not cover code, tests, CI or releases. Status: Settled, scope documentation only.
- **S6 Plan template for all software projects** Effect: every software project gets a plan in the same form. Status: Settled.
- **S7 1 Replace the repo's contents** Effect: the old Swift form-message app goes; its history stays in git; at that time nothing changed until the build go-ahead. Status: Settled; the Phase 1 go-ahead was later given (see the entry Phase 1 code started).
- **S8 Mail path, first choice** Effect: the Resend free plan sending from a subdomain of the owner's own domain. Replaced by S9. Status: Replaced.
- **S9 2a Mail path, second choice** Effect: iCloud first, Resend fallback. Apple's terms explicitly restrict automated access in the quoted interference clause, and application to this service was unresolved. Status: Replaced by entry 2b.
- **S10 2b Mail path, current** Effect: a dedicated Gmail account is the selected sender for this service, for now; iCloud dropped; Resend on a subdomain stays the fallback. Account creation, any credential and any send are later phases, each authorized separately. Google terms and limits for automated sending are researched first. The mail adapter stays provider-neutral. Status: Settled for now; changed twice.
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
- **S22 9 Lockout residual** Effect: the owner accepts that someone who knows the owner's address can delay the owner for up to an hour at a time, for the owner-only trial; a bot check is added before Salutant opens to anyone else. Status: Settled.
- **S23 Document set approved** Effect: Specification, Decision Log and Evidence Record, with the Charter and Build Plan. Status: Settled.
- **S24 Specification split out; old drafts deleted** Effect: the Specification is its own document; superseded documents were removed. Status: Done.
- **S25 Playbook for the project** Effect: Salutant gets the Playbook first (named Blueprint when chosen, renamed Playbook on 7 October). Delete only fully superseded documents after replacement content is reviewed and committed to git. Status: Settled; deletions pending review.
- **S26 Playbook** Effect: the three files Charter, Build Plan and Specification together are called the Playbook (named Blueprint when chosen, renamed Playbook on 7 October), and it is the standard set for every software project. Status: Settled.

## Open decisions

- **Emergency key staleness** The owner must decide whether to accept or shorten the proposed [10 minutes] end-to-end window after an emergency key revoke. Failing closed is a requirement and is not the owner's agreement to the window. Not approved.
- **Final contract values** Every bracketed value in the Specification returns for the owner's approval with the plan.
- **Epoch mechanism** Chosen and tested in Phase 1; reported back.
- **Callback return path** Two options, decided by Phase 1 test; reported back.
- **Timing tolerance** Measured in Phase 1; the owner reviews the measured values before any launch.
- **Gmail sending** Whether Google allows automated sending from the dedicated account, with which credential type. Researched before any account creation, credential or send.
- **Phase approval** Approval of the Build Plan covers Phase 1 (local code and mocks) only. Historical: a separate code go-ahead was required, and was later given for Phase 1 only (see the entry Phase 1 code started). Merge and every later phase are not covered and need their own authorization.

## Recommendations not approved

- **Six-digit code** A recommendation. Not in the owner's words.
- **Bot check before opening to others** The owner accepted that it is added before opening (S22); its design is not chosen.
