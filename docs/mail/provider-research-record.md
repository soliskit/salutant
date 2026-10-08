# Mail provider research record

Lane B. Status words: verified means the author read the source and
recorded when; reported means someone else said so; unproven means
nobody has shown it.

## Current mail path (S27)

Sign-in mail goes through Resend from mail.soliskit.com. S27 in
`docs/decision-log.md` replaces decision 2's dedicated Gmail path;
iCloud stays dropped. Provider limits and real delivery remain
unproven for this service. No account setup or real sending is approved
by the mail-path choice.

## Dedicated Gmail account (superseded decision 2)

Historical research, not an active gate for the selected Resend path.

- Unproven. Whether Google's terms and sending limits allow automated
  sign-in email from a dedicated Gmail account (SMTP or API) is not
  established. This was a gate of the then-planned Gmail delivery phase; S27
  supersedes that path.
- Account creation is a later, separately approved phase. Any credential
  for it is collected through a vault link, never in chat. Real sends
  remain a later, separately authorized phase.
- The account is dedicated to this service so the owner's personal mail
  is never on the sending path.

## Resend (selected provider under S27)

- Verified by the plan author on 7 October 2026.
  https://resend.com/pricing - Free is 100 emails a day, 3,000 a month,
  with 30-day data retention. What the 30-day retention covers is not
  stated in the text read, so assume a code can sit there for up to
  30 days after it has expired (R13).
- Verified by the plan author on 7 October 2026.
  https://resend.com/docs/knowledge-base/account-quotas-and-limits -
  the quota counts sent and received emails, and each recipient counts
  separately.
- Verified by the plan author on 7 October 2026.
  https://resend.com/docs/dashboard/domains/introduction - Resend
  recommends sending from a dedicated subdomain and allows several
  verified subdomains of one domain. The earlier selection rule was: a
  subdomain of the owner domain used only for these emails, not the
  root domain, not a name used for a web page, with no existing mail
  records. The From address is a no-reply address on that subdomain.
  Open and click tracking turned off.

## What phase 1 does with this

Nothing sends. The mock adapter (see the adapter contract) is
provider-neutral. Phase 1 remains local and fake; it proves no real
Resend delivery. S27 selects Resend for the later real-delivery phase
without changing the service interface.
