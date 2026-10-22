# Test and integrate an escrow checkout

The SDK is a server-side client. A website's browser talks to its own backend;
that backend uses this SDK and keeps the `sk_test_` or `sk_live_` key secret.
Never put an API key in browser JavaScript, a mobile app, or a public source map.

## Choose a test path

| Path | What it proves | Needs |
|---|---|---|
| Package tests | SDK behavior against scripted HTTP responses | Node.js for TypeScript; PHP/Composer or the repository wrappers for PHP |
| SDK end-to-end harness | Both SDKs authenticate and their requests work against the real partner API | A running escrow backend and a `sk_test_` partner key |
| Checkout examples | The shopper-facing payment flow, including asynchronous funding and webhooks | The end-to-end prerequisites, plus a reachable webhook URL for webhook delivery |

The end-to-end harness creates test transactions and a temporary webhook
endpoint. It deletes the webhook endpoint, but leaves the test transactions in
the test account. It refuses a live key. Do not pass a live key to the examples
or test harness.

## Run package tests

From the repository root:

```bash
cd packages/typescript
npm ci
npm test
npm run typecheck
npm run build
```

PHP checks (the wrappers use a local installation when available and otherwise
run PHP/Composer in containers):

```bash
./tools/composer.sh install
./tools/php.sh vendor/bin/phpunit
./tools/php.sh vendor/bin/phpstan analyse --no-progress
```

These checks use test doubles and fixtures. They do not prove that a running
backend accepts the request; use the live sandbox harness for that.

## Run the SDK end-to-end harness against a local backend

You need the escrow backend repository alongside this one, Docker, Go, and a
working local backend configuration. Start Postgres, Redis, and NATS from the
backend repository, then run its migrations, API, and worker using its local
development instructions. The API default is `http://localhost:8080`.

**Check ports before starting the backend.** Its default host ports are 5432
(Postgres), 6379 (Redis), 4222 (NATS), and 8080 (API). If another project owns
one of these ports, configure a separate local mapping/port for the escrow
stack and use that API URL below. Keep the backend containers on their normal
internal ports. Do not point this harness at another project's database.

In the SDK repository root, provision a local test partner/key. This writes
only to the backend's `escrow` development database and prints a secret test
key once; keep it out of logs and source control:

```bash
node e2e/seed-partner.mjs
```

If the backend uses a named Compose project (for example, to isolate it from
other local databases), select that exact project before seeding:

```bash
BACKEND_COMPOSE_PROJECT=codex-developerportal-test node e2e/seed-partner.mjs
```

The seeder runs `docker compose exec` only against that project's Postgres
container. Confirm the project name with `docker compose ls` first. On
PowerShell, set `$env:BACKEND_COMPOSE_PROJECT` to the project name for the
command, then clear it when finished.

Build TypeScript, install the PHP SDK dependencies, then run both clients
against the API. Replace the sample key with the value just printed. Set
`BACKEND_DIR` if your backend checkout is not `../escrow-backend`.

```bash
cd packages/typescript && npm ci && npm run build && cd ../..
./tools/composer.sh install
node e2e/run.mjs --key sk_test_REPLACE_ME --base http://localhost:8080
```

To run only the TypeScript half, add `--skip-php`. The harness checks test-mode
authentication, create/retrieve/list, idempotent replay and conflict handling,
validation errors, contact masking, and webhook endpoint lifecycle/URL
validation. It does not wait for funding or settlement; the standalone checkout
examples cover asynchronous payment behavior.

The commands above use a POSIX shell. On Windows, run them from WSL or Git Bash
with Docker Desktop and Go available there. The backend must be reachable from
that same environment. The PHP wrapper can use Docker Desktop when PHP is not
installed locally.

## Exercise the shopper payment flow

Start the TypeScript example with a sandbox test key:

```bash
npx tsx --tsconfig examples/typescript-node/tsconfig.json examples/typescript-node/checkout.ts --key sk_test_REPLACE_ME --base http://localhost:8080
```

Or use the PHP example:

```bash
php examples/php-plain/checkout.php --key=sk_test_REPLACE_ME --base=http://localhost:8080
```

For a local webhook receiver, run the example's receiver on port 9095 and
provide its signing secret as documented in [`examples/README.md`](../examples/README.md).
The API requires a publicly reachable HTTPS webhook URL and rejects private
network destinations, so use a controlled HTTPS tunnel for local delivery.

In test mode, the final four digits of the buyer phone select the charge case:

| Phone suffix | Expected result |
|---|---|
| `0000` | Charge does not start; the escrow still exists and payment can be retried |
| `9999` | Prompt is sent but not confirmed; the transaction remains unfunded |
| Other digits | Sandbox funding completes asynchronously after a short delay |

For example, pass `--phone +254700110000` or `--phone +254700119999` to the
TypeScript example to force the two failure paths. A test key uses invented
funds and cannot move real money. The examples refuse to start with a live key.

## Put it into a website checkout

Use this sequence for a store such as a custom e-commerce site or WooCommerce
integration:

1. The website backend creates/locks its local order and records a stable order
   identifier before calling the SDK.
2. The backend calls `transactions.create()` with that order identifier as both
   `partner_reference` and the idempotency key. Send integer KES minor units
   (`250000` means KES 2,500.00) and the buyer's real contact details.
3. Save the returned escrow transaction ID on the local order immediately. If
   the network times out, retry with the same idempotency key; do not create a
   second escrow.
4. Handle all create outcomes. `payment: null` means the shopper must accept in
   the escrow app before anything is charged. A payment status of `failed`
   means retry the payment on that transaction. For card/bank, send the shopper
   to `payment.checkout_url` when present. For M-Pesa, show the shopper that an
   STK prompt is expected and wait for confirmation.
5. Keep the order in a pending-payment state until a verified
   `transaction.funded` webhook arrives. Funding is asynchronous in test mode
   and production. Use webhooks as the source of truth; polling is only a
   fallback for reconciliation.
6. Verify webhook signatures over the unmodified raw request body, store each
   event ID to deduplicate deliveries, and use its sequence/status to ignore
   stale updates. Return 2xx quickly, then process fulfillment in a job.
7. When your fulfillment process ships the goods, call `transactions.ship()`.
   The shopper confirms receipt or the inspection timer expires; the merchant
   cannot release the escrow itself.

The API key and SDK belong in the website's trusted server environment. Never
call the partner API directly from the storefront. See the
[TypeScript](../packages/typescript/README.md) and
[PHP](../packages/php/README.md) package guides for framework-specific setup,
webhook raw-body access, and error handling.

## API reference and Swagger

The canonical HTTP contract is
[`shared/partner-openapi.yaml`](../shared/partner-openapi.yaml). The backend
repository keeps a matching copy at `api/partner-openapi.yaml` and serves it at
`GET /partner/openapi.yaml`. Start the backend with the optional `docs` Compose
profile to run two separate local Swagger UIs: partner/SDK endpoints at
`http://localhost:8081` and the private company API at `http://localhost:8082`.
The partner UI defaults to the local development API; authorize it with a
`sk_test_` key before using **Try it out**. Keep the private UI loopback-only.

The SDK does not expose a different HTTP API, so this repository does not need a
second Swagger contract. This guide documents SDK usage; the OpenAPI file
remains the endpoint/schema reference.
