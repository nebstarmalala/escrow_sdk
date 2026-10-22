/**
 * A complete test-mode integration: create an escrow, charge the shopper, wait
 * for funding, mark it shipped — and receive the webhooks that tell you all of
 * that happened.
 *
 * Deliberately built on `node:http` rather than Express, so it runs with no
 * install beyond the SDK itself. The framework-specific part of a real
 * integration is one line — getting the raw request body — and every framework's
 * version of that line is in the package README.
 *
 *   npx tsx examples/typescript-node/checkout.ts \
 *     --key sk_test_xxx --secret whsec_xxx --base http://localhost:8080
 *
 * It refuses to run with a live key.
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

import {
  ConflictError,
  Escrow,
  EscrowError,
  ValidationError,
  verify,
  WebhookSignatureError,
  type Transaction,
} from '@aminitrust/escrow-sdk';

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    secret: { type: 'string' },
    base: { type: 'string', default: 'http://localhost:8080' },
    phone: { type: 'string', default: '+254700111222' },
    port: { type: 'string', default: '9095' },
  },
});

if (values.key === undefined) {
  console.error('usage: checkout.ts --key sk_test_... [--secret whsec_...] [--base URL]');
  process.exit(2);
}

const escrow = new Escrow({ apiKey: values.key, baseUrl: values.base });

// Step 0, and the one people skip.
//
// The mode comes from the key itself, with no network call. Checking it here
// costs nothing; discovering at checkout that you shipped the wrong key costs a
// good deal more.
if (escrow.livemode) {
  console.error('refusing to run: this is a LIVE key and this example moves money.');
  process.exit(2);
}

const orderId = `order_${Date.now()}`;

async function main(): Promise<void> {
  const me = await escrow.me();
  console.log(`authenticated as partner ${me.partner_id} (test mode, ${me.rate_limit_per_min}/min)`);

  if (values.secret !== undefined) startWebhookReceiver(values.secret);

  // 1. Create the escrow.
  //
  // The idempotency key IS the order id. It is unique per logical request by
  // construction, and reusing it on a retry is what stops a timeout from
  // creating a second escrow and sending the shopper a second M-Pesa prompt.
  const created = await escrow.transactions.create(
    {
      partner_reference: orderId,
      amount_minor: 250_000, // KES 2,500.00 - must be a whole shilling
      title: 'Sony WH-1000XM5',
      description: 'Wireless noise-cancelling headphones, sealed',
      item_type: 'PHYSICAL',
      category: 'electronics',
      buyer: { phone: values.phone, full_name: 'Test Shopper' },
      delivery_method: 'COURIER',
      delivery_timeline: '3-5 days',
      inspection_period_hours: 48,
      payment: { method: 'mpesa', phone: values.phone },
      metadata: { example: 'typescript-node' },
    },
    { idempotencyKey: orderId },
  );

  // A REAL integration writes this id against its own order here, before doing
  // anything else. If the process dies now, the escrow exists and you want to
  // be able to find it.
  console.log(`escrow ${created.transaction.id} (${created.transaction.reference}) created`);

  // 2. Handle BOTH create outcomes.
  if (created.payment === null || created.payment === undefined) {
    // The shopper already has an escrow account, so nothing was charged and
    // they must accept in their own app. Skip this branch and these orders
    // silently never fund - it is the likeliest bug in a new integration.
    console.log('shopper has an existing escrow account; awaiting their acceptance in-app.');
    console.log('nothing has been charged. Stopping here.');
    return;
  }

  // 3. A failed charge is not a failed escrow.
  if (created.payment.status === 'failed') {
    console.log(`charge did not start (${created.payment.failure_reason ?? 'unknown'}); retrying`);

    // Retry the PAYMENT, not the transaction. Creating a second transaction
    // here is the mistake this endpoint exists to prevent.
    const retry = await escrow.transactions.pay(created.transaction.id, {
      method: 'mpesa',
      phone: values.phone,
    });
    if (retry.status === 'failed') {
      console.log(`retry did not start (${retry.failure_reason ?? 'payment declined'}); use another payment method or number.`);
      return;
    }
  }

  // 4. Wait for funding.
  //
  // POLLING IS A SHORTCUT so this runs without a public URL. A real
  // integration acts on the transaction.funded webhook; the receiver below
  // shows what that looks like.
  const funded = await waitForStatus(created.transaction.id, ['funded'], 90);
  if (funded === null) {
    console.log('not funded within 90s. In the sandbox, a phone ending 9999 never confirms.');
    return;
  }
  console.log(`funded: ${funded.amount_minor} minor units held in escrow`);

  // 5. Ship. This starts the shopper's inspection window.
  const shipped = await escrow.transactions.ship(created.transaction.id);
  console.log(`marked shipped; status is now ${shipped.status}`);

  // 6. And then you wait. Release is the SHOPPER'S act - there is no endpoint
  // here that could do it - or auto-release fires when the inspection window
  // expires.
  console.log('waiting for the shopper to confirm receipt, or for auto-release.');

  if (values.secret !== undefined) {
    console.log('webhook receiver still listening; Ctrl-C to stop.');
  }
}

async function waitForStatus(
  id: string,
  wanted: string[],
  seconds: number,
): Promise<Transaction | null> {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    const txn = await escrow.transactions.retrieve(id);
    if (wanted.includes(txn.status as string)) return txn;
    await new Promise((r) => setTimeout(r, 2000));
  }

  return null;
}

function startWebhookReceiver(secret: string): void {
  const port = Number.parseInt(values.port ?? '9095', 10);

  createServer((req, res) => {
    // The RAW bytes. Not JSON.parse'd and re-stringified: that changes key
    // order and whitespace, the signature stops matching, and the error reads
    // like a wrong secret rather than a body-handling mistake.
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));

    req.on('end', () => {
      void (async () => {
        try {
          const event = await verify(
            Buffer.concat(chunks),
            req.headers['escrow-signature'] as string | undefined,
            secret,
          );

          // Acknowledge FIRST, work afterwards. Anything slower than a couple
          // of seconds gets retried, and the retry arrives while you are still
          // handling the first copy.
          res.writeHead(200).end();

          console.log(`  webhook: ${event.type} (seq ${event.sequence ?? '-'})`);
        } catch (err) {
          if (err instanceof WebhookSignatureError) {
            console.error(`  webhook REJECTED: ${err.message}`);
            res.writeHead(400).end();
            return;
          }
          res.writeHead(500).end();
        }
      })();
    });
  }).listen(port, () => {
    console.log(`webhook receiver on :${port} (point an endpoint at it through a tunnel)`);
  });
}

main().catch((err: unknown) => {
  // The error taxonomy in practice: branch on the class, never on the message.
  if (err instanceof ValidationError) {
    console.error(`the API refused the request: ${err.message}`, err.details ?? '');
  } else if (err instanceof ConflictError) {
    console.error(`conflict (${err.code}): ${err.message}`);
    console.error('if this is IDEMPOTENCY_CONFLICT, the key was reused for a different body.');
  } else if (err instanceof EscrowError) {
    console.error(`${err.name} [${err.code}] ${err.message}`);
    if (err.requestId !== undefined) console.error(`request id: ${err.requestId}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
