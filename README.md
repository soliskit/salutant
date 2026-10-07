# Salutant

Salutant checks that someone controls an email address and hands an app a
short-lived signed proof. Email in, code sent, code checked, signed proof
out. Nothing else.

This repository currently holds **phase 1: a local, fully mocked prototype**.
The service, a stub app, and the test suite run on any machine with
Node.js 20 or later. No real emails are sent, no accounts or credentials
are used, and nothing is deployed. The earlier Swift form-message app was
replaced by owner decision; its history is preserved in git.

## Layout

- `docs/decisions/` - owner decisions this work is built on.
- `docs/contract/` - the lane A contract the code is written against.
- `docs/mail/` - the mock mail adapter contract and provider research.
- `docs/evidence/` - recorded test results.
- `docs/findings/` - what the prototype showed about the proposed
  production mechanisms (epoch, callback, key cache, purge).
- `src/` - the mock service and the stub app.
- `tests/` - the test suite, named by requirement.

## Run the tests

```
npm test
```

Zero dependencies. The mock uses only Web Crypto and Node's built-in test
runner.

## Status words used in docs

- Verified: someone read the source and recorded when.
- Reported: someone else said so; not re-read.
- Unproven: nobody has shown it.

Phase 1 forbids merge, deployment, real sends, and any account setup.
Each later phase needs its own owner authorization.
