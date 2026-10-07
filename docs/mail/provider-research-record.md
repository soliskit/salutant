# Mail provider research record

Lane B. Status words: verified means the author read the source and
recorded when; reported means someone else said so; unproven means
nobody has shown it.

## Decision 2 (7 October 2026, changed twice same day)

Mail path: **a dedicated Gmail account created just for this service's
sending, for now; Resend free on a subdomain of the owner's domain as
the fallback.** An earlier "iCloud first" preference was dropped the
same day.

## Dedicated Gmail account (current choice)

- Unproven. Whether Google's terms and sending limits allow automated
  sign-in email from a dedicated Gmail account (SMTP or API) is not
  established. Research is a gate of the real-delivery phase, with
  re-review, before any real send.
- Account creation is a later, separately approved phase. Any credential
  for it is collected through a vault link, never in chat. Real sends
  remain a later, separately authorized phase.
- The account is dedicated to this service so the owner's personal mail
  is never on the sending path.

## Resend (fallback)

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
  verified subdomains of one domain. Selection rule for the fallback: a
  subdomain of the owner domain used only for these emails, not the
  root domain, not a name used for a web page, with no existing mail
  records. The From address is a no-reply address on that subdomain.
  Open and click tracking turned off.

## What phase 1 does with this

Nothing sends. The mock adapter (see the adapter contract) stands in
for both candidates. The provider-neutral interface is the deliverable
that lets the real-delivery phase choose between the dedicated Gmail
account and Resend without service changes.
