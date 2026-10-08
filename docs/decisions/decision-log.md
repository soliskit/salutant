# Decision log

Owner decisions this repository is built on, recorded 7 October 2026.
Dates are when the owner decided. Bracketed values are proposals from the
plan, not owner decisions. This log deliberately carries no message
references or personal details; the full provenance lives in the
private Salutant Phase 1 Plan (plus the owner's later change to
decision 2).

## Settled

1. **Replace this repo's contents.** The old Swift form-message app goes.
   Its history stays in git. (Owner decision before phase 1.)
2. **Mail path (superseded by S27 in `docs/decision-log.md`).**
   Historical choice: a dedicated Gmail account created just for this
   service's sending, for now; Resend's free plan sending from a
   subdomain of the owner's domain as the fallback. Whether Google's
   terms and sending limits allow automated sign-in email is
   unverified, so research is a gate of the real-delivery phase, with
   re-review. Account creation, any credential (collected through a
   vault link, never in chat), and any send are later, separately
   approved phases. Phase 1 uses a mock adapter and is unaffected.
   (Owner decision 7 October 2026; changed twice same day - first
   "Resend first", then "iCloud first if possible", then the Gmail path.)
   Current path under S27: Resend from mail.soliskit.com; iCloud stays
   dropped. Account setup, credentials and real sends still need
   separate authorization. Phase 1 remains local and mocked.
3. **Who can sign in.** An approved list only, starting with the owner's
   address. People are added only by the owner's say-so.
4. **One app or many.** One service that can serve many apps. The first
   connected app is the owner's video-call app.
5. **Where the code page lives.** The code-entry page is served by the
   Cloudflare service. Public pages are on GitHub Pages. Whether GitHub
   Pages can block framing is sampled-header evidence only, not a
   verified platform claim.
6. **Lost mailbox.** No shortcut in the sign-in. Fixed by changing the
   approved address in the service settings, using the owner's own
   Cloudflare and GitHub access.
7. **Runtime and storage.** A Cloudflare Worker with its built-in free
   storage for codes and limits. The restore safety switch (the epoch)
   is a separate setting only the owner can change.
8. **Trial recipients.** Trial emails go only to the owner's own address.
9. **Lockout residual.** The owner accepts that someone who knows the
   owner's address can delay them for up to an hour at a time, for the
   owner-only trial. A bot check is added before the service opens to
   anyone else.
10. **Browser binding stays.** A sign-in code verifies only from the
    browser that requested it, so a phished or observed code is useless
    elsewhere. The accepted cost: under a slot-filling attack a code
    mailed from an attacker's challenge cannot be used in the owner's
    own browser - the owner is delayed until a slot frees, never locked
    out (finding 5). (Owner decision 7 October 2026, answering the
    phase 1 finding-5 question: "Keep it".)

Also settled: free is required, with single-solution hosting where
possible (hosting order for all projects: GitHub, then Cloudflare, then
Vercel); build our own email sign-in rather than adding a service; this
repo is the home of the email service; failure is closed.

## Open

1. **Emergency-revoke exposure.** After an emergency key revoke, an app
   with a warm cache may accept the old key for up to [10 minutes] end to
   end. The owner accepts that window or chooses a shorter cache. Not
   approved yet.
2. **Final contract values.** Proposed in the lane A contract. Final
   values return to the owner with measured results.
3. **Timing tolerance.** A hard maximum is in the contract. Measured
   numbers are reviewed by the owner before launch.
4. **Epoch mechanism.** A candidate is in the contract. Choosing and
   testing it is an exit criterion of this prototype. Until then, restore
   fails closed.
5. **Key staleness number.** One end-to-end bound, proposed as
   [10 minutes]. The owner's call: accept or shorten.
6. **Later phases.** This approval covers phase 1 (local and mocks)
   only. Cloud tests, real delivery through the S27 Resend path
   (provider limits and delivery still unproven), the owner-only live
   trial, and launch each need their
   own authorization after measured values are reviewed.
