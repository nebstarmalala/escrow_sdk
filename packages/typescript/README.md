# @aminitrust/escrow-sdk

Server-side client for the **Escrow Partner API** — hold a shopper's money in
escrow from your own checkout, release it when they confirm receipt.

Node 18+. Zero runtime dependencies. Ships ESM and CommonJS.

```bash
npm install @aminitrust/escrow-sdk
```

To run the clients against the test-mode backend and walk through a website
checkout, see the [testing and integration guide](../../docs/testing-and-integration.md).

> **Server-side only.** A secret key can move your money. There is no origin
> check that makes shipping one to a browser safe.

## Quickstart

```ts
import { Escrow } from '@aminitrust/escrow-sdk';

const escrow = new Escrow({ apiKey: process.env.ESCROW_SECRET_KEY! });

// The mode comes from the key itself, with no network call. Assert it at boot;
// discovering at checkout that you shipped the wrong key is too late.
if (!escrow.livemode && process.env.NODE_ENV === 'production') {
  throw new Error('refusing to start with a test key in production');
}

const { transaction, payment } = await escrow.transactions.create(
  {
    partner_reference: order.id,
    amount_minor: 250_000,          // KES 2,500.00 — must be a whole shilling
    title: 'Sony WH-1000XM5',
    description: 'Wireless noise-cancelling headphones',
    item_type: 'PHYSICAL',
    category: 'electronics',
    buyer: { phone: '+254700111222', full_name: 'Wanjiru M.' },
    delivery_method: 'COURIER',
    delivery_timeline: '3-5 days',
    payment: { method: 'mpesa', phone: '+254700111222' },
  },
  { idempotencyKey: order.id },
);
```

Save `transaction.id` against your order **before** you rely on it. If the call
times out, the escrow may well exist.

### Handle both create outcomes

```ts
if (payment === null) {
  // The shopper already has an escrow account. Nothing was charged; they accept
  // in their own app. Skip this branch and these orders silently never fund.
}

if (payment?.status === 'failed') {
  // The escrow exists and is accepted — the *charge* did not start.
  // Retry the payment. Creating a second transaction is the mistake this
  // endpoint exists to prevent.
  const retry = await escrow.transactions.pay(transaction.id, { method: 'mpesa', phone });
  if (retry.status === 'failed') {
    // Try a different payment method or shopper number; the escrow still exists.
  }
}
```

## What you can and cannot do

```ts
await escrow.transactions.ship(id);              // starts the inspection window
await escrow.transactions.cancel(id);            // only before funding
await escrow.transactions.refund(id, { reason }); // any time before release
```

**There is no release method, and there will not be one.** Funds move when the
shopper confirms receipt or the inspection timer expires. That you cannot decide
it is the product — it is what makes a stranger willing to pay you up front. You
can always give money back; you can never take it.

## Listing

Lists are async-iterable and lazily paged. The next request is only made when
the current page runs out, so breaking out early costs nothing.

```ts
for await (const txn of escrow.transactions.list({ status: 'funded' })) {
  if (txn.partner_reference === order.id) return txn;
}
```

`await escrow.transactions.list().all()` collects everything, which is
convenient and a liability on a large account.

## Errors

Branch on the class. Never on `message` — it is written for humans and may be
reworded in any release.

```ts
import { ConflictError, RateLimitError, ValidationError } from '@aminitrust/escrow-sdk';

try {
  await escrow.transactions.create(params, { idempotencyKey: order.id });
} catch (err) {
  if (err instanceof ValidationError) { /* fix the request */ }
  else if (err instanceof ConflictError) { /* see below */ }
  else if (err instanceof RateLimitError) { /* err.retryAfterSeconds */ }
}
```

| Class | Codes |
|---|---|
| `ValidationError` | `VALIDATION_ERROR`, `UNPROCESSABLE` |
| `AuthenticationError` | `UNAUTHORIZED` |
| `PermissionError` | `FORBIDDEN`, `INSUFFICIENT_SCOPE` |
| `NotFoundError` | `NOT_FOUND` |
| `ConflictError` | `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `INVALID_STATE_TRANSITION` |
| `RateLimitError` | `RATE_LIMITED` |
| `InsufficientFundsError` | `INSUFFICIENT_FUNDS` |
| `ApiError` | `SERVICE_UNAVAILABLE`, `INTERNAL`, and anything unrecognised |
| `ConnectionError` | no response at all — DNS, reset, timeout |

## Retries and idempotency

The SDK retries `429`, `5xx` and transport failures — three attempts by default,
full jitter, honouring `Retry-After`. **It never retries a `409`**, including the
"still in flight" case that is technically safe to repeat: a plain `CONFLICT`
also covers a duplicate `partner_reference`, and auto-retrying would paper over a
duplicate-order bug.

An idempotency key is sent on every write, reused across the SDK's own retries.
That reuse is the entire point — a fresh key per attempt would create a second
escrow and fire a second M-Pesa prompt at the shopper.

**Pass your own key.** A generated one is unique within a single call but not
across a process restart: if your job runs again after a timeout, a generated key
is a *different* key. Your order id is unique by construction and makes replays
visible in your own logs.

```ts
const result = await escrow.transactions.create(params, { idempotencyKey: order.id });
result.replayed; // true when the API returned a stored response instead of executing
```

## Webhooks

```ts
import { verify } from '@aminitrust/escrow-sdk';

const event = await verify(rawBody, signatureHeader, process.env.ESCROW_WEBHOOK_SECRET!);
```

> ### `rawBody` must be the raw bytes
>
> Not a parsed object, and not an object re-serialised with `JSON.stringify`.
> Round-tripping through JSON changes key order and whitespace, the signature
> stops matching, and the error looks like a wrong secret rather than a
> body-handling mistake. **This is the single most common integration bug against
> this API.**

Getting the raw body:

```ts
// Express — raw() on THIS ROUTE ONLY, before any global express.json()
app.post('/webhooks/escrow', express.raw({ type: 'application/json' }), handler);
//   req.body is a Buffer

// Fastify — addContentTypeParser, or the fastify-raw-body plugin
//   req.rawBody

// Next.js app router
//   const rawBody = await req.text();

// Node http
//   collect the chunks yourself; they are already raw
```

`verify` **throws** rather than returning a boolean. A merchant who forgets to
check a flag has no verification at all, and that failure is silent.

### Three properties to build against

- **Delivery is at-least-once.** Deduplicate on `event.id`, which is stable
  across retries and replays.
- **Order is not guaranteed.** A `transaction.funded` can arrive after a
  `transaction.shipped`. Treat `data.object.status` as the truth and use
  `sequence` to discard a stale update.
- **Respond 2xx quickly.** Anything else is retried with backoff for about 22
  hours, then dead-lettered. Acknowledge first, work afterwards.

Rotating a secret sends two signatures during the grace window, so a receiver
holding either the old or the new one keeps verifying. Deploy in any order.

## Test mode

A `sk_test_` key drives the whole lifecycle with no real money — real webhooks,
real timers, real ledger postings, invented funds. The last four digits of the
buyer's phone select an outcome:

| Phone ends | Outcome |
|---|---|
| `0000` | the charge never starts |
| `9999` | the shopper sees the prompt and walks away |
| anything else | succeeds after a short delay |

That second one is the commonest real failure and the one integrations forget.

## Deploy the backend first, always

The API rejects an unrecognised request property rather than ignoring it. A new
*request* field therefore breaks any client that sends it before the server ships
it. Additive response fields and new event types are safe in either order.

## Licence

MIT.
