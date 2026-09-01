# End-to-end harness

Drives both SDKs through a real test-mode lifecycle against a running backend.

This is the layer the other two cannot reach. The shared fixtures prove the three
implementations compute the same signature; the mock-server tests prove each
client handles a scripted response. Neither proves that the request a client
*builds* is one the API actually accepts — a header spelled differently, a query
parameter the server ignores, a body it rejects. That only shows up here, and it
showed up here immediately: the first version of the SSRF check passed for the
wrong reason, because `http://169.254.169.254` was rejected for being `http`
before the address guard ever ran.

## Running it

You need the backend checked out beside this repo, and Docker for its Postgres,
Redis and NATS.

```bash
# 1. dependencies only
cd ../escrow-backend
docker compose up -d postgres redis nats

# 2. migrate and run the API natively
set -a && . ./.env && set +a
go run ./cmd/escrow --mode=migrate
go run ./cmd/escrow --mode=api &
go run ./cmd/escrow --mode=worker &
```

> The API is run natively rather than through `docker compose up api`, because
> the backend's Dockerfile currently pins a Go base image older than its own
> `go.mod` requires and the image build fails. Running it with the local
> toolchain sidesteps that without changing the backend.

```bash
# 3. provision a partner and a test key
cd ../escrow-sdk
BACKEND_DIR=../escrow-backend node e2e/seed-partner.mjs

# 4. drive both SDKs
cd packages/typescript && npm run build && cd ../..
./tools/composer.sh install
node e2e/run.mjs --key sk_test_...
```

`--skip-php` runs only the TypeScript half.

## Why seeding writes to Postgres directly

Admin provisioning starts with `--mode=admin-bootstrap`, which prints a one-time
invite link that a human then uses to set a password and enrol MFA. Automating
that would be testing the admin onboarding flow. What this harness is for is
exercising the SDKs against a live API, so it inserts the partner, its two seller
users and an API key directly — generating the key material exactly as the
backend does, including hashing the `sk_test_` prefix along with the body.

## What it checks

Both SDKs, same key, same backend:

- authentication, and that a `sk_test_` key reports test mode
- create, and that a test key cannot produce a `livemode: true` transaction
- **idempotent replay** — a second identical create returns the same id with
  `Idempotent-Replay: true` rather than a second escrow
- **`IDEMPOTENCY_CONFLICT`** — the same key with a different body is refused
- that the buyer contact the merchant supplied comes back **masked**
- cursor pagination through the iterator
- `404` for an id that does not exist, `422` for a validation failure
- webhook endpoint registration, the signing secret returned exactly once, and
  deletion
- that a webhook URL resolving to link-local space is refused

The masking check is worth its own note: a test-mode create resolves to a
partner-scoped sandbox buyer (`…@partners.escrow.local`), never to the real
contact the merchant supplied. That is the sandbox boundary holding, observed
from outside.

## Not covered

Funding and settlement. Reaching `funded` needs the sandbox paygate provider
configured and the scheduler running, and the whole lifecycle then takes tens of
seconds of real waiting. The `examples/` integrations do drive that path — this
harness stops at the request/response surface it was built to check.
