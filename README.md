# Salutant

Salutant proves that a person controls an email address. You enter your
address, we send a code, you enter it, and the app gets a short-lived
signed proof. That is all it does, and that is the point. A sign-in that
does one thing is a sign-in you can check.

Today this repo holds phase 1: a local prototype with every outside
piece mocked. It runs on any machine with Node.js 20 or later. CI runs
Node 22. It sends no real email, uses no accounts or credentials, and
deploys nothing. We start local to catch mistakes before real email or a launch.

## Layout

- `docs/decision-log.md` holds the decisions this work is built on.
- `docs/evidence-record.md` has one row per requirement, with its result
  and a link to its test.
- `docs/mail/` describes the mock mail adapter.
- `docs/findings/` records what the prototype showed about restoring
  saved data safely, returning sign-in results to an app, refreshing
  signing keys, and deleting old records, with timing and processor-time
  measurements.
- `src/` holds the mock service and the stub app.
- `tests/` holds the test suite, named by requirement.

## Run the tests

```
npm test
```

There are no dependencies. The mock uses only Web Crypto and Node's
built-in test runner.

## Status words

- Verified: someone read the source and recorded when.
- Reported: someone else said so, and nobody re-read it.
- Unproven: nobody has shown it.

Phase 1 is merged. It covers local code and mocks only. Deployment, real
sends and account setup each need their own go-ahead.

## Limits and behavior

Code lifetime, send and request limits, and the mail budget are set in
the Playbook, on the How It Works tab. Local tests cover each one.
