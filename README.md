# Escrow Partner SDKs

Server-side SDKs for integrating the Escrow Partner API into a marketplace or online store. Create an escrow for an order, collect payment from the shopper, track funding and delivery, and let the shopper confirm receipt.

The API holds funds during the transaction. A merchant can ship, cancel an eligible unfunded order, or refund before release. **A merchant cannot release escrow funds.** The shopper confirms receipt, or the inspection period expires, before settlement.

| Language | Package | Runtime | Package documentation |
| --- | --- | --- | --- |
| TypeScript / JavaScript | [`@aminitrust/escrow-sdk`](packages/typescript) | Node.js 18+ | [TypeScript SDK guide](packages/typescript/README.md) |
| PHP | [`aminitrust/escrow-sdk`](packages/php) | PHP 8.1+ | [PHP SDK guide](packages/php/README.md) |

Both SDKs implement Partner API version `1.0.0` from the shared contract at [`shared/partner-openapi.yaml`](shared/partner-openapi.yaml). The TypeScript package supports ESM and CommonJS and has zero runtime dependencies. The PHP package uses PSR-18/PSR-17 HTTP interfaces.

## Contents

- [How an integration works](#how-an-integration-works)
- [Install](#install)
- [Node.js quickstart](#nodejs-quickstart)
- [Payment outcomes](#payment-outcomes)
- [Webhooks](#webhooks)
- [Test mode](#test-mode)
- [Security and production checklist](#security-and-production-checklist)
- [API features](#api-features)
- [Repository layout](#repository-layout)
- [Developing and testing this repository](#developing-and-testing-this-repository)
- [API compatibility](#api-compatibility)
- [License](#license)

## How an integration works

The SDK belongs in your trusted server application. Your store's browser calls your server; your server uses the SDK and keeps the partner secret key private.

```text
Shopper's browser  →  Your ecommerce backend  →  Escrow Partner API
                             ↑                         │
                             └──── signed webhook ─────┘
```

A typical order moves through these steps:

1. Your backend creates or locks its local order and assigns it a stable ID.
2. Your backend creates an escrow transaction using that order ID as `partner_reference` and the idempotency key.
3. Your backend saves the returned escrow transaction ID to the order and tells the browser whether to redirect to checkout or wait for M-Pesa.
4. The shopper pays and the API sends signed, asynchronous webhooks to your registered endpoint.
5. Your backend verifies each webhook, records and deduplicates it, then updates the local order. Treat a verified funded event as the signal that payment cleared.
6. Your fulfillment system ships the goods and calls `transactions.ship()`. The shopper confirms receipt or the inspection period completes.

The API and SDK also support existing Escrow shoppers. In that case a newly created transaction can require acceptance in the shopper's Escrow account before any payment begins. Handle that response explicitly; it is not a successful charge.

## Install

### TypeScript / JavaScript

```bash
npm install @aminitrust/escrow-sdk
```

The TypeScript package requires Node.js 18 or newer. It includes ESM and CommonJS builds and TypeScript declarations.

### PHP

```bash
composer require aminitrust/escrow-sdk
```

The PHP package requires PHP 8.1 or newer. It is framework agnostic and uses PSR-18 / PSR-17. If your application does not already provide an HTTP client, install one such as Guzzle:

```bash
composer require guzzlehttp/guzzle
```

## Node.js quickstart

Create a partner account and a **test-mode** API key before integrating. Store the key in your hosting provider's secret store or in a local `.env` file excluded from version control. The production API base URL is the SDK default, so you normally do not need to set `baseUrl`.

```ts
import { Escrow } from '@aminitrust/escrow-sdk';

const apiKey = process.env.ESCROW_SECRET_KEY;
if (!apiKey) throw new Error('ESCROW_SECRET_KEY is required');

const escrow = new Escrow({ apiKey });

// Check the key mode when the service starts, before accepting orders.
if (process.env.NODE_ENV === 'production' && !escrow.livemode) {
  throw new Error('Refusing to start production with an Escrow test key');
}
```

### Create an escrow from a checkout route

The following Express-style example shows the server-side shape. Load the order and buyer from your own database; do not trust a browser-provided price or order total.

```ts
app.post('/checkout/:orderId/escrow', async (req, res, next) => {
  try {
    const order = await orders.getForCheckout(req.params.orderId, req.user.id);
    if (!order) return res.sendStatus(404);

    const result = await escrow.transactions.create(
      {
        partner_reference: order.id,
        amount_minor: order.totalMinor, // integer minor units; 250000 = KES 2,500.00
        title: order.title,
        description: order.description,
        item_type: 'PHYSICAL',
        category: order.category,
        buyer: {
          phone: order.buyerPhone,
          full_name: order.buyerName,
        },
        delivery_method: 'COURIER',
        delivery_timeline: order.deliveryEstimate,
        payment: { method: 'mpesa', phone: order.buyerPhone },
      },
      { idempotencyKey: order.id },
    );

    // Persist the ID before replying. If this request times out, retry with
    // the same idempotency key rather than creating a second escrow.
    await orders.saveEscrowTransactionId(order.id, result.transaction.id);

    if (result.payment === null) {
      await orders.setPaymentState(order.id, 'awaiting_buyer_acceptance');
      return res.status(202).json({ status: 'awaiting_buyer_acceptance' });
    }

    if (result.payment.status === 'failed') {
      await orders.setPaymentState(order.id, 'payment_failed');
      return res.status(202).json({
        status: 'payment_failed',
        escrowTransactionId: result.transaction.id,
      });
    }

    await orders.setPaymentState(order.id, 'awaiting_payment');
    return res.status(202).json({
      status: 'awaiting_payment',
      checkoutUrl: result.payment.checkout_url ?? null,
    });
  } catch (error) {
    next(error);
  }
});
```

For card or bank checkout, return the SDK's `checkout_url` to the browser and send the shopper there. For M-Pesa, show a message that an STK prompt is being sent and wait for the asynchronous result. Do not mark an order paid just because transaction creation returned successfully.

If a charge fails to start, retry payment on the existing escrow transaction with `escrow.transactions.pay(transactionId, params)`. Do not create another escrow for the same order. See the [TypeScript guide](packages/typescript/README.md) for the full API, errors, pagination, disputes, and retry behavior.

### PHP

The PHP SDK exposes the same Partner API using PHP arrays:

```php
use Aminitrust\Escrow\Escrow;

$apiKey = getenv('ESCROW_SECRET_KEY');
if (!$apiKey) {
    throw new RuntimeException('ESCROW_SECRET_KEY is required');
}

$escrow = new Escrow(['api_key' => $apiKey]);
$result = $escrow->transactions->create([
    'partner_reference' => $order->id,
    'amount_minor' => $order->totalMinor,
    'title' => $order->title,
    'description' => $order->description,
    'item_type' => 'PHYSICAL',
    'category' => $order->category,
    'buyer' => ['phone' => $order->buyerPhone, 'full_name' => $order->buyerName],
    'delivery_method' => 'COURIER',
    'delivery_timeline' => $order->deliveryEstimate,
    'payment' => ['method' => 'mpesa', 'phone' => $order->buyerPhone],
], $order->id); // stable idempotency key
```

See the [PHP guide](packages/php/README.md) for payment outcomes, types, framework-specific raw-body access, and errors.

## Payment outcomes

Creation returns an escrow transaction and a payment result. Your application should handle each result:

| Result | Meaning | What your store should do |
| --- | --- | --- |
| `payment === null` | The shopper already has an Escrow account and must accept the transaction in the app. No charge has started. | Keep the order pending and tell the shopper to accept. Wait for the funded webhook. |
| `payment.status === 'failed'` | The escrow exists, but the charge did not start or failed. | Let the shopper retry payment on the same transaction or choose another method. |
| `payment.status === 'prompt_sent'` | An M-Pesa STK prompt was sent. Payment is still asynchronous. | Tell the shopper to check their phone and wait for the webhook. |
| `payment.checkout_url` is present | A hosted card or bank checkout is ready. | Redirect the shopper to that URL. A browser return is not proof of payment. |

Amounts are integer minor units. For KES, `250000` represents KES 2,500.00. The amount must be a whole number of shillings. Build it from your saved order total, not a client-supplied value.

### Idempotency and retries

Pass your own idempotency key on write operations. A local order ID is usually a good choice because it stays stable when a request is retried after a timeout or process restart.

```ts
const result = await escrow.transactions.create(params, {
  idempotencyKey: order.id,
});

if (result.replayed) {
  // The API returned the earlier result for this logical request.
}
```

The SDK retries transient network failures, `429` responses, and server errors with the same key. It does not retry `409 Conflict` automatically: a conflict may indicate a duplicate order or a request that still needs to settle. Handle typed SDK errors rather than parsing error message text.

## Webhooks

Funding and later transaction changes happen asynchronously. Register a publicly reachable HTTPS endpoint with the API and subscribe to events your integration needs. Store the webhook signing secret when the API returns it; it is only shown once.

For Express, register a raw body parser on the webhook route **before** any global `express.json()` parser consumes the request:

```ts
import express from 'express';
import { Escrow, WebhookSignatureError } from '@aminitrust/escrow-sdk';

const app = express();
const escrow = new Escrow({ apiKey: process.env.ESCROW_SECRET_KEY! });
const webhookSecret = process.env.ESCROW_WEBHOOK_SECRET!;

app.post(
  '/webhooks/escrow',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = await escrow.webhooks.verify(
        req.body,
        req.get('Escrow-Signature'),
        webhookSecret,
      );
    } catch (error) {
      if (error instanceof WebhookSignatureError) return res.sendStatus(400);
      return res.sendStatus(400);
    }

    // Save/deduplicate event.id and enqueue it in a durable job or outbox
    // before acknowledging. Keep this request handler fast.
    await webhookInbox.acceptOnce(event.id, event);
    return res.sendStatus(200);
  },
);

// Mount JSON parsing on ordinary API routes after the raw webhook route.
app.use(express.json());
```

The webhook verifier needs the exact bytes sent by the API. Do not parse JSON and then serialize it again before verification; whitespace and property order can change the signature. The SDK checks the timestamp and signature using a timing-safe comparison.

Webhook delivery is at least once, and event order is not guaranteed. Deduplicate using `event.id`; when applying state changes, use the event's transaction status and sequence so an older event cannot overwrite newer state. Acknowledge valid deliveries quickly after persisting them, then perform fulfillment work asynchronously. Return a client error for an invalid signature rather than asking the API to retry an unverifiable request.

Other supported ways to obtain raw bytes:

- **Fastify:** register a raw body parser or use a raw-body plugin.
- **Next.js App Router:** read the request with `await request.text()` before parsing.
- **Plain PHP:** read `file_get_contents('php://input')`.
- **Laravel / Symfony:** use `$request->getContent()`.

The SDK also provides webhook endpoint and delivery resources for managing endpoints, inspecting deliveries, and retrying a delivery. See the package guides for details.

## Test mode

An `sk_test_` key uses invented funds and cannot move real money. Test and live objects are isolated. The SDK exposes `escrow.livemode` from the key prefix before making a network request, so you can fail fast if a test key is configured in production.

The sandbox still delivers payment results asynchronously. The final four digits of the buyer's phone select a test outcome:

| Phone ends with | Sandbox result |
| --- | --- |
| `0000` | Payment fails to start; retry payment on the existing escrow. |
| `9999` | The M-Pesa prompt is sent but never confirmed; the order stays unfunded. |
| Other digits | Payment succeeds after a short delay. |

For a local backend setup, partner key provisioning, runnable checkout examples, and detailed sandbox steps, see [Testing and integrating a payment flow](docs/testing-and-integration.md) and [Examples](examples/README.md). The examples refuse to start with a live key.

## Security and production checklist

- Keep the partner API key on your server. Never embed it in browser JavaScript, a mobile app, a public source map, or a checked-in config file.
- Keep the webhook signing secret private and separate from the API key.
- Use test keys for local development and staging; use a live key only in the production secret store.
- Check `escrow.livemode` at application startup and fail if it does not match the environment.
- Calculate the amount from your trusted order record and use integer minor units.
- Use the same stable idempotency key for every retry of one order creation request.
- Save the escrow transaction ID against your local order before depending on the result.
- Verify webhooks over raw bytes, deduplicate event IDs, and process state changes asynchronously.
- Treat webhooks as the source of truth for payment state. A shopper returning to your site does not prove payment succeeded.
- Deploy backend support for a new request field before deploying an SDK integration that sends it.

## API features

The SDKs cover the Partner API, including:

- Transaction creation, retrieval, listing, payment retries, shipping, cancellation, and refunds.
- Dispute retrieval and listing.
- Webhook endpoint creation, retrieval, listing, updates, deletion, and secret rotation.
- Webhook delivery inspection and retry.
- Typed errors, bounded retries for transient responses, idempotency keys, and cursor pagination.
- Shared webhook-signature fixtures used by the SDKs and backend.

The full request and response schemas are in [`shared/partner-openapi.yaml`](shared/partner-openapi.yaml). The API rejects unknown request properties. The published `/partner/v1` contract is frozen: additive response fields and event types can ship without breaking clients; breaking request changes require a new API version.

## Repository layout

```text
shared/       Partner API OpenAPI contract, fixtures, and contract metadata
packages/     TypeScript and PHP SDKs
examples/     Runnable test-mode checkout and webhook receiver examples
docs/         Sandbox, local setup, and ecommerce integration guide
e2e/          End-to-end scripts for a running backend
tools/        PHP and Composer wrappers for local or container-based checks
```

`shared/fixtures/` provides cross-language vectors. The SDK implementations and backend consume the same fixtures so webhook signatures and event payload handling can be checked against one source.

## Developing and testing this repository

### TypeScript SDK

```bash
cd packages/typescript
npm ci
npm test
npm run typecheck
npm run build
```

The package also provides `npm run generate` to regenerate API types from the shared OpenAPI document, plus `npm run generate:check` and `npm run spec:check` to check generated types and contract synchronization.

### PHP SDK

The wrappers use a local PHP / Composer installation when available, or Docker if not:

```bash
./tools/composer.sh install
./tools/php.sh vendor/bin/phpunit
./tools/php.sh vendor/bin/phpstan analyse --no-progress
```

### End-to-end and checkout examples

The end-to-end scripts need the Escrow backend running in test mode and a test partner key. They create test objects in that account. Read the [testing guide](docs/testing-and-integration.md) before running them; it documents database, Docker, port, and webhook tunnel requirements.

## API compatibility

The machine-readable contract at [`shared/partner-openapi.yaml`](shared/partner-openapi.yaml) describes the HTTP API used by both packages. The backend repository keeps a matching copy. The API rejects unknown request fields, so deploy backend support before sending a newly added request field from an SDK integration. Additive response fields and event types are designed to remain compatible with `/partner/v1`; breaking contract changes belong in a new API version.

See [`shared/SPEC.md`](shared/SPEC.md) for the contract update workflow and versioning rules.

## License

Both package manifests declare the MIT license.
