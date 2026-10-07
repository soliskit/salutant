# Mail adapter contract, v1

Lane B. The service never talks to a mail provider directly. It talks to
an adapter with this interface, so the provider (a dedicated Gmail
account for now, Resend on a subdomain as fallback - decision 2) can
change without touching service code. Phase 1 ships only the mock
implementation; no account, DNS, credential or real send exists.

## Interface

```
send({ requestId, to, subject, text }) -> Promise<SendResult>
reconcile(requestId) -> Promise<ReconcileResult>
```

- `requestId`: required. One per send request, chosen by the service and
  stored in the durable reservation before the adapter is called.
- `to`: the recipient address. In the owner-only trial this is always
  the owner's own address (decision 8).
- `subject`: generic, for example "Your sign-in code". Never contains
  the code (R13).
- `text`: the body. The code appears only in the body.

## SendResult semantics

- `{ outcome: "accepted", providerId }` - the provider took the message.
  Acceptance is not delivery and never produces a proof (R5).
- `{ outcome: "uncertain" }` - the result is unknown (timeout, network
  reset). The send may or may not have happened. The service never
  retries an uncertain send automatically; the reservation stays and
  counts against the budget, and the request is reconciled against the
  provider's send record. The person sees a plain message to check email
  or try again after the cooldown.
- `{ outcome: "failed" }` - the provider refused. Counts as a failure:
  no proof, a plain message, service stays closed on repeated failure.

## ReconcileResult semantics

`reconcile(requestId)` reads the provider's own send record for that
request id and returns `{ state: "sent" | "absent" | "unknown" }`. Used
to settle uncertain sends without resending.

## Rules the service relies on

1. The adapter is the only place provider credentials exist. The mock
   has none.
2. Sending is at least once in effect. The service does not ask the
   adapter for exactly-once.
3. A double-click is one request: the service dedupes by idempotency key
   before a reservation is written, so the adapter never sees the same
   request id twice.
4. The response to the person never waits on the adapter (R3), so mail
   provider latency cannot show in response time.
5. The adapter adds no tracking: no open pixels, no click tracking, no
   rewritten links.

## Mock implementation

`src/mail-mock.js`. Records every call in an outbox the tests can read,
supports injected behaviors (`ok`, `uncertain`, `failed`), and records
reconciliations. It performs no network I/O.
