# Examples

Two runnable integrations against **test mode**. Both refuse to start with a live
key.

They are written to be *ported*, not imported — the sequence is the same in any
language, and the comments mark the two or three places where the obvious
implementation is wrong.

## What you need

A partner account and a `sk_test_` key. There is no self-serve signup yet; ask
for both.

## TypeScript

```bash
cd packages/typescript && npm install && npm run build && cd ../..
npx tsx examples/typescript-node/checkout.ts --key sk_test_xxx --base http://localhost:8080
```

With a webhook receiver as well:

```bash
npx tsx examples/typescript-node/checkout.ts --key sk_test_xxx --secret whsec_xxx --port 9095
```

Built on `node:http` rather than Express, so it runs with no install beyond the
SDK. The framework-specific part of a real integration is one line — getting the
raw request body — and every framework's version of that line is in the
[package README](../packages/typescript/README.md#webhooks).

## PHP

```bash
./tools/composer.sh install
php examples/php-plain/checkout.php --key=sk_test_xxx --base=http://localhost:8080
```

And the receiver, separately:

```bash
ESCROW_WEBHOOK_SECRET=whsec_xxx php -S 127.0.0.1:9095 examples/php-plain/webhook.php
```

Point a webhook endpoint at that address through a tunnel. Locally is not enough:
the API refuses to deliver to private addresses, and it checks again at DNS
resolution time, so a public name that resolves to `127.0.0.1` will not work
either.

## What they demonstrate

1. **Checking the key's mode before doing anything.** No network call needed.
2. **Creating a transaction with an idempotency key** — the order id, which is
   unique per logical request by construction.
3. **Both create outcomes.** A new shopper is auto-accepted and charged; one who
   already has an escrow account comes back `pending_acceptance` with nothing
   charged. Skip that branch and those orders silently never fund.
4. **Surviving a failed charge.** The escrow still exists — retry the payment
   rather than creating a second transaction.
5. **Waiting for asynchronous funding**, which is asynchronous in test mode too.
6. **Marking shipped**, which starts the shopper's inspection window.
7. **Verifying a webhook** over the raw bytes, and acknowledging before working.

## Try the failure paths

The last four digits of the buyer's phone pick the sandbox outcome:

```bash
# the charge never starts
npx tsx examples/typescript-node/checkout.ts --key sk_test_xxx --phone +254700110000

# the shopper sees the prompt and walks away - the commonest real failure,
# and the one integrations forget
npx tsx examples/typescript-node/checkout.ts --key sk_test_xxx --phone +254700119999
```

## Two shortcuts a real integration should not copy

- **They poll for funding.** Only so they run standalone without a public URL.
  Use the `transaction.funded` webhook.
- **They have no persistence.** A real integration records the escrow id against
  its own order before making the call, so a crash mid-request is recoverable.
