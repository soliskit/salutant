# Mail adapter contract

The service never talks to a mail provider directly. It talks to an
adapter with the interface below. That keeps the provider replaceable:
Resend from mail.soliskit.com (S27 in `docs/decision-log.md`) can change
without touching service code. Phase 1 ships only the mock. No account,
DNS record, credential or real send exists.

## Interface

R numbers are requirements in `docs/evidence-record.md`. S numbers are
decisions in `docs/decision-log.md`.

```
send({ requestId, to, subject, text }) -> Promise<SendResult>
reconcile(requestId) -> Promise<ReconcileResult>
```

- `requestId`: required. One per send request, chosen by the service and
  stored in a reservation (a saved record of the send and its counters)
  before the adapter is called.
- `to`: the recipient address. In the owner-only trial this is always
  the owner's own address (S21 in `docs/decision-log.md`).
- `subject`: generic, for example "Your sign-in code". Never contains
  the code (requirement R13).
- `text`: the body. The code appears only in the body.

## SendResult semantics

- `{ outcome: "accepted", providerId }` - the provider took the message.
  Acceptance is not delivery. It never produces a proof, the signed
  statement that the address was checked (requirement R5).
- `{ outcome: "uncertain" }` - the result is unknown (timeout, network
  reset). The send may or may not have happened. The service never
  retries an uncertain send automatically; the reservation stays and
  counts against the budget, and the request is reconciled against the
  provider's send record. The request returns the same generic response
  without waiting for the send result. The local page does not yet offer
  a cooldown message or resend control.
- `{ outcome: "failed" }` - the provider refused. The failed send cannot
  produce a proof. The person can retry after the cooldown.

## ReconcileResult semantics

`reconcile(requestId)` reads the provider's own send record for that
request id and returns `{ state: "sent" | "absent" | "unknown" }`. Used
to settle uncertain sends without resending.

## Rules the service relies on

1. The adapter is the only place provider credentials exist.
2. Sending is at least once in effect. The service does not ask the
   adapter for exactly-once.
3. Requests with the same idempotency key (a client-chosen ID that
   marks a repeat) reuse one response and one send. The service dedupes
   before it writes a reservation, so the adapter never sees the same
   request id twice. The local page does not yet supply that key, so its
   double-click protection is unproven.
4. The adapter adds no tracking: no open pixels, no click tracking, no
   rewritten links.

## Mock implementation

`src/mail-mock.js`. Records every send call in `attempts` and accepted
messages in an outbox the tests can read. Supports injected outcomes
(`accepted`, `uncertain`, `failed`) and records reconciliations. It
performs no network I/O.
