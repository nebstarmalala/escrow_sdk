# Escrow Partner SDKs

Server-side clients for the **Escrow Partner API** — hold a shopper's money in
escrow from your own checkout, release it when they confirm receipt.

| Language | Package | Requires |
|---|---|---|
| TypeScript / JavaScript | `@aminitrust/escrow-sdk` | Node 18+ |
| PHP | `aminitrust/escrow-sdk` | PHP 8.1+ |

Both speak API version **1.0.0** and are built from the same frozen contract in
[`shared/partner-openapi.yaml`](shared/partner-openapi.yaml).

## What the API does

Your backend creates an escrow for an order. The shopper is charged (M-Pesa STK,
card, or bank) and the money sits in escrow rather than reaching you. You ship.
The shopper confirms receipt through a link they were sent — or an inspection
timer runs out — and the funds settle to your account.

**You cannot release funds yourself, and there is no endpoint that lets you.**
That is the product: the shopper's confidence comes from the fact that you
holding their money is not a thing you can decide. You *can* refund in full at
any point before release.

## Install

```bash
npm install @aminitrust/escrow-sdk
```

```bash
composer require aminitrust/escrow-sdk
```

## Quickstart

```ts
import { Escrow } from '@aminitrust/escrow-sdk';

const escrow = new Escrow({ apiKey: process.env.ESCROW_SECRET_KEY! });

const { transaction, payment } = await escrow.transactions.create({
  partner_reference: order.id,
  amount_minor: 250_000,          // KES 2,500.00 - must be a whole shilling
  title: 'Sony WH-1000XM5',
  description: 'Wireless noise-cancelling headphones',
  item_type: 'PHYSICAL',
  category: 'electronics',
  buyer: { phone: '+254700111222', full_name: 'Wanjiru M.' },
  delivery_method: 'COURIER',
  delivery_timeline: '3-5 days',
  payment: { method: 'mpesa', phone: '+254700111222' },
});

if (payment === null) {
  // The shopper already has an escrow account and must accept in-app first.
  // Nothing has been charged. Skip this branch and these orders silently
  // never fund - it is the likeliest bug in a new integration.
}
```

```php
$escrow = new Aminitrust\Escrow\Escrow(['api_key' => getenv('ESCROW_SECRET_KEY')]);

$result = $escrow->transactions->create([...]);
```

## Test mode

A key beginning `sk_test_` drives the whole lifecycle with no real money —
real webhooks, real timers, real ledger postings, invented funds. Both SDKs
expose `livemode` from the key itself, with no network call, so you can refuse
to boot with the wrong one:

```ts
if (!escrow.livemode && process.env.NODE_ENV === 'production') throw new Error('test key in production');
```

The last four digits of the buyer's phone select a sandbox outcome: `…0000` the
charge never starts, `…9999` the shopper sees the prompt and walks away.

For a step-by-step sandbox checkout, including the TypeScript and PHP end-to-end
harness, see [Testing and integrating a payment flow](docs/testing-and-integration.md).

## Webhooks

Verify every delivery. Both packages ship a verifier that handles the timestamp
tolerance, the timing-safe compare, and multiple signatures during a secret
rotation:

```ts
const event = escrow.webhooks.verify(rawBody, req.headers['escrow-signature'], secret);
```

**`rawBody` must be the raw bytes, not a parsed and re-serialised object.**
JSON round-tripping changes key order and whitespace, the signature stops
matching, and the cause is not obvious from the error. This is the single most
common integration bug. See each package's README for how to get the raw body
out of your framework.

## Repository layout

```
shared/       the frozen spec, its provenance, and the cross-language fixtures
packages/     the two SDKs
examples/     runnable integrations
docs/         sandbox testing and payment-flow integration guide
tools/        local dev wrappers
```

The machine-readable partner API documentation is [`shared/partner-openapi.yaml`](shared/partner-openapi.yaml).
It describes the HTTP API both SDKs call; the backend repository keeps a
matching copy. The backend's current Swagger UI renders its broader platform
API spec, so point a partner API explorer at this existing file if one is needed.

`shared/fixtures/` holds signature vectors and sample payloads that **all three**
implementations run — including the Go backend. Two clients agreeing with each
other proves nothing; they can be wrong together. Pinning all three to one
artefact is what makes the agreement mean something.

## Working on this repo

```bash
cd packages/typescript && npm install && npm test
```

PHP does not need to be installed. The wrappers use a local `php`/`composer` if
present, and otherwise the `php:8.1-cli` and `composer:2` images:

```bash
./tools/composer.sh install
./tools/php.sh vendor/bin/phpunit
./tools/php.sh vendor/bin/phpstan analyse --no-progress
```

### The spec is frozen

`/partner/v1` is a published contract. Additive changes — new optional response
fields, new endpoints, new event types — ship under 1.0.0. Anything that could
break a working integration goes to `/partner/v2`.

One consequence bites in the other direction: the API rejects an unrecognised
request property rather than ignoring it, so a new *request* field breaks any
client that sends it before the server ships it. **Deploy the backend first,
always.**

See [`shared/SPEC.md`](shared/SPEC.md) for how to take in a spec update.

## Licence

MIT.
