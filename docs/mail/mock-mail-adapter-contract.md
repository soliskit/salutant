# Mail Adapter Contract

The adapter sends mail and resolves uncertain sends. It keeps the service
interface unchanged when providers change. The selected path is Resend from
mail.soliskit.com. Phase 1 uses only the mock:
no provider account, domain setup, credential, or real send.

## Interface

R numbers identify [requirements](../evidence-record.md).

```
send({ requestId, to, subject, text }) -> Promise<SendResult>
reconcile(requestId) -> Promise<ReconcileResult>
```

- `requestId`: required. One per send request, chosen by the service and
  stored in a reservation (a saved record of the send and its counters)
  before the adapter is called.
- `to`: the recipient address. In the owner-only trial this is always
  the owner's own address.
- `subject`: generic, for example "Your sign-in code". Never contains
  the code (requirement R13).
- `text`: the body. The code appears only in the body.

## Send results

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
  produce a proof. A later request follows the approved one-minute resend wait.

## Reconciliation results

`reconcile(requestId)` reads the provider's own send record for that
request id and returns `{ state: "sent" | "absent" | "unknown" }`. Used
to settle uncertain sends without resending.

## Adapter rules

1. The adapter is the only place provider credentials exist.
2. The adapter gives no exactly-once guarantee. This service never
   retries an uncertain send automatically. A duplicate email is possible
   only if a later authorized attempt retries the send. Reusing the
   client key below does not start another send.
3. A client can mark a repeated request with an idempotency key. Reusing
   that key returns the first response without sending another email.
   The service handles repeats before saving the send reservation.
   This client key is separate from `requestId`, which the service gives
   the adapter for one send. The adapter never sees that request ID twice.
   The local page supplies no client key yet, so its double-click
   protection is unproven.
4. Do not send from a personal mailbox. The adapter adds no tracking: no open pixels, no click tracking, no
   rewritten links.

## Mock implementation

`src/mail-mock.js`. Records every send call in `attempts` and accepted
messages in an outbox the tests can read. Supports injected outcomes
(`accepted`, `uncertain`, `failed`) and records reconciliations. It
performs no network I/O.
