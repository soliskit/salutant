# Salutant

Email sign-in: a code to the inbox, a signed proof to the app.

Salutant proves control of an email address and gives the app a short-lived,
signed proof. The person
requests a code and enters it in the same browser. The app checks the proof
before completing sign-in. Salutant does not manage the app's account or session.

This repo holds Phase 1: a local prototype that replaces outside services
with stand-ins. It runs on any machine with
Node.js 20 or later, sends no real email, uses no accounts or
credentials, and deploys nothing. Phase 1 is merged. Deployment, real
sends, and account setup each need their own go-ahead.

## Layout

- [Requirements](docs/requirements.md) defines behavior and acceptance checks.
- `docs/decision-log.md` holds the decisions this work is built on.
- `docs/evidence-record.md` has one row per requirement, with its result
  and a link to its test.
- `docs/mail/` describes the mock mail adapter.
- `docs/findings/` records the six Phase 1 findings: restoring saved
  data safely, getting the sign-in result to the app, refreshing signing
  keys, deleting old records, tying a code to one browser, and timing and
  processor time.
- `src/` holds the mock service and the stub app.
- `tests/` holds the test suite, named by requirement.

## Run the tests

```
npm test
```

There are no dependencies. The mock uses only Web Crypto and Node's
built-in test runner.

## Limits and behavior

The [Decision Log](docs/decision-log.md) records code lifetime, request
limits, and the mail-budget policy. The [Evidence Record](docs/evidence-record.md)
links local checks and names what still needs cloud testing. The private
Playbook holds the full plan.
