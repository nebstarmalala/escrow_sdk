# aminitrust/escrow-sdk

Server-side client for the **Escrow Partner API** — hold a shopper's money in
escrow from your own checkout, release it when they confirm receipt.

PHP 8.1+. Framework-agnostic: PSR-18 / PSR-17 only, so it uses whatever HTTP
client your application already has.

```bash
composer require aminitrust/escrow-sdk
```

If your project has no PSR-18 client yet, any will do:

```bash
composer require guzzlehttp/guzzle
```

> **Server-side only.** A secret key can move your money.

## Quickstart

```php
use Aminitrust\Escrow\Escrow;

$escrow = new Escrow(['api_key' => getenv('ESCROW_SECRET_KEY')]);

// The mode comes from the key itself, with no network call. Assert it at boot;
// discovering at checkout that you shipped the wrong key is too late.
if (!$escrow->livemode && $appEnv === 'production') {
    throw new RuntimeException('refusing to start with a test key in production');
}

$result = $escrow->transactions->create([
    'partner_reference' => $order->id,
    'amount_minor' => 250000,          // KES 2,500.00 - must be a whole shilling
    'title' => 'Sony WH-1000XM5',
    'description' => 'Wireless noise-cancelling headphones',
    'item_type' => 'PHYSICAL',
    'category' => 'electronics',
    'buyer' => ['phone' => '+254700111222', 'full_name' => 'Wanjiru M.'],
    'delivery_method' => 'COURIER',
    'delivery_timeline' => '3-5 days',
    'payment' => ['method' => 'mpesa', 'phone' => '+254700111222'],
], $order->id);
```

Save `$result['transaction']['id']` against your order **before** you rely on it.
If the call times out, the escrow may well exist.

### Handle both create outcomes

```php
if ($result['payment'] === null) {
    // The shopper already has an escrow account. Nothing was charged; they
    // accept in their own app. Skip this branch and these orders silently
    // never fund.
}

if (($result['payment']['status'] ?? null) === 'failed') {
    // The escrow exists and is accepted - the *charge* did not start.
    // Retry the payment. Creating a second transaction is the mistake this
    // endpoint exists to prevent.
    $escrow->transactions->pay($result['transaction']['id'], [
        'method' => 'mpesa',
        'phone' => $phone,
    ]);
}
```

## What you can and cannot do

```php
$escrow->transactions->ship($id);                        // starts the inspection window
$escrow->transactions->cancel($id);                      // only before funding
$escrow->transactions->refund($id, ['reason' => '...']); // any time before release
```

**There is no `release()` method, and there will not be one.** Funds move when
the shopper confirms receipt or the inspection timer expires. That you cannot
decide it is the product — it is what makes a stranger willing to pay you up
front. You can always give money back; you can never take it.

## Listing

Lists are lazily paged. The next request is only made when the current page runs
out, so breaking out early costs nothing.

```php
foreach ($escrow->transactions->list(['status' => 'funded']) as $txn) {
    if ($txn['partner_reference'] === $order->id) {
        return $txn;
    }
}
```

`->all()` collects everything, which is convenient and a liability on a large
account.

## Types

The API surface is arrays — what `json_decode` gives you anyway. `src/Types.php`
is generated from the frozen OpenAPI spec and carries PHPStan array shapes for
every object, so at level 8 a mistyped key is a static error rather than a null
at runtime, and the shapes say which fields are optional.

## Errors

Catch the class. Never match on the message — it is written for humans and may be
reworded in any release.

```php
use Aminitrust\Escrow\Errors\{ConflictError, RateLimitError, ValidationError};

try {
    $escrow->transactions->create($params, $order->id);
} catch (ValidationError $e) {          // fix the request
} catch (ConflictError $e) {            // see below
} catch (RateLimitError $e) {           // $e->retryAfterSeconds
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

All extend `Aminitrust\Escrow\Errors\EscrowError`, which carries `$errorCode`,
`$status`, `$details` and `$requestId`.

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
is a *different* key. Your order id is unique by construction.

```php
$result['replayed']; // true when the API returned a stored response instead of executing
```

## Webhooks

```php
use Aminitrust\Escrow\Webhooks;

$event = Webhooks::verify(
    file_get_contents('php://input'),
    $_SERVER['HTTP_ESCROW_SIGNATURE'] ?? null,
    getenv('ESCROW_WEBHOOK_SECRET'),
);
```

> ### The body must be the raw bytes
>
> Not a decoded array, and not an array re-encoded with `json_encode`.
> Round-tripping through JSON changes key order and whitespace, the signature
> stops matching, and the error looks like a wrong secret rather than a
> body-handling mistake. **This is the single most common integration bug against
> this API.**

Getting the raw body:

| | |
|---|---|
| plain PHP | `file_get_contents('php://input')` |
| Laravel | `$request->getContent()` |
| Symfony | `$request->getContent()` |
| Slim / PSR-7 | `(string) $request->getBody()` |
| WordPress / WooCommerce | `file_get_contents('php://input')` |

`verify` **throws** rather than returning a boolean. A merchant who forgets to
check a flag has no verification at all, and that failure is silent. Answer a
rejected delivery with `400`, not `500` — a `5xx` tells the API to retry, and a
delivery that cannot be verified will not verify on the fourth attempt either.

### Three properties to build against

- **Delivery is at-least-once.** Deduplicate on `$event['id']`, which is stable
  across retries and replays.
- **Order is not guaranteed.** A `transaction.funded` can arrive after a
  `transaction.shipped`. Treat `data.object.status` as the truth and use
  `sequence` to discard a stale update.
- **Respond 2xx quickly.** Anything else is retried with backoff for about 22
  hours, then dead-lettered. Acknowledge first, work afterwards.

Rotating a secret sends two signatures during the grace window, so a receiver
holding either the old or the new one keeps verifying. Deploy in any order.

## Test mode

A `sk_test_` key drives the whole lifecycle with no real money. The last four
digits of the buyer's phone select an outcome:

| Phone ends | Outcome |
|---|---|
| `0000` | the charge never starts |
| `9999` | the shopper sees the prompt and walks away |
| anything else | succeeds after a short delay |

That second one is the commonest real failure and the one integrations forget.

## Supplying your own HTTP client

Discovery finds whatever PSR-18 client your application has. Pass one explicitly
when you need it configured — a proxy, mTLS, corporate egress:

```php
$escrow = new Escrow(['api_key' => $key], $myPsr18Client, $requestFactory, $streamFactory);
```

## Deploy the backend first, always

The API rejects an unrecognised request property rather than ignoring it. A new
*request* field therefore breaks any client that sends it before the server ships
it. Additive response fields and new event types are safe in either order.

## Licence

MIT.
