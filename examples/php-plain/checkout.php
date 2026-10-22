<?php

/**
 * A complete test-mode integration in plain PHP: create an escrow, charge the
 * shopper, wait for funding, mark it shipped.
 *
 * No framework, on purpose. The framework-specific part of a real integration is
 * one line - getting the raw request body for signature verification - and every
 * framework's version of that line is in the package README.
 *
 *   php examples/php-plain/checkout.php --key=sk_test_xxx --base=http://localhost:8080
 *
 * It refuses to run with a live key.
 */

declare(strict_types=1);

require __DIR__ . '/../../packages/php/vendor/autoload.php';

use Aminitrust\Escrow\Errors\ConflictError;
use Aminitrust\Escrow\Errors\EscrowError;
use Aminitrust\Escrow\Errors\ValidationError;
use Aminitrust\Escrow\Escrow;

$opts = getopt('', ['key:', 'base::', 'phone::']);

if (!isset($opts['key'])) {
    fwrite(STDERR, "usage: checkout.php --key=sk_test_... [--base=URL] [--phone=+254...]\n");
    exit(2);
}

$phone = (string) ($opts['phone'] ?? '+254700111222');

$escrow = new Escrow([
    'api_key' => (string) $opts['key'],
    'base_url' => (string) ($opts['base'] ?? 'http://localhost:8080'),
]);

// Step 0, and the one people skip.
//
// The mode comes from the key itself, with no network call. Checking it here
// costs nothing; discovering at checkout that you shipped the wrong key costs a
// good deal more.
if ($escrow->livemode) {
    fwrite(STDERR, "refusing to run: this is a LIVE key and this example moves money.\n");
    exit(2);
}

$orderId = 'order_' . time();

try {
    $me = $escrow->me();
    printf("authenticated as partner %s (test mode, %d/min)\n", $me['partner_id'], $me['rate_limit_per_min']);

    // 1. Create the escrow.
    //
    // The idempotency key IS the order id. It is unique per logical request by
    // construction, and reusing it on a retry is what stops a timeout from
    // creating a second escrow and sending the shopper a second M-Pesa prompt.
    $created = $escrow->transactions->create([
        'partner_reference' => $orderId,
        'amount_minor' => 250000, // KES 2,500.00 - must be a whole shilling
        'title' => 'Sony WH-1000XM5',
        'description' => 'Wireless noise-cancelling headphones, sealed',
        'item_type' => 'PHYSICAL',
        'category' => 'electronics',
        'buyer' => ['phone' => $phone, 'full_name' => 'Test Shopper'],
        'delivery_method' => 'COURIER',
        'delivery_timeline' => '3-5 days',
        'inspection_period_hours' => 48,
        'payment' => ['method' => 'mpesa', 'phone' => $phone],
        'metadata' => ['example' => 'php-plain'],
    ], $orderId);

    $txn = $created['transaction'];

    // A REAL integration writes this id against its own order here, before
    // doing anything else. If the process dies now, the escrow exists and you
    // want to be able to find it.
    printf("escrow %s (%s) created\n", $txn['id'], $txn['reference']);

    // 2. Handle BOTH create outcomes.
    if ($created['payment'] === null) {
        // The shopper already has an escrow account, so nothing was charged and
        // they must accept in their own app. Skip this branch and these orders
        // silently never fund - it is the likeliest bug in a new integration.
        echo "shopper has an existing escrow account; awaiting their acceptance in-app.\n";
        echo "nothing has been charged. Stopping here.\n";
        exit(0);
    }

    // 3. A failed charge is not a failed escrow.
    if (($created['payment']['status'] ?? null) === 'failed') {
        printf("charge did not start (%s); retrying\n", $created['payment']['failure_reason'] ?? 'unknown');

        // Retry the PAYMENT, not the transaction. Creating a second transaction
        // here is the mistake this endpoint exists to prevent.
        $retry = $escrow->transactions->pay($txn['id'], ['method' => 'mpesa', 'phone' => $phone]);
        if (($retry['status'] ?? null) === 'failed') {
            printf("retry did not start (%s); use another payment method or number.\n", $retry['failure_reason'] ?? 'payment declined');
            exit(0);
        }
    }

    // 4. Wait for funding.
    //
    // POLLING IS A SHORTCUT so this runs without a public URL. A real
    // integration acts on the transaction.funded webhook.
    $funded = null;
    $deadline = time() + 90;
    while (time() < $deadline) {
        $current = $escrow->transactions->retrieve($txn['id']);
        if ($current['status'] === 'funded') {
            $funded = $current;
            break;
        }
        sleep(2);
    }

    if ($funded === null) {
        echo "not funded within 90s. In the sandbox, a phone ending 9999 never confirms.\n";
        exit(0);
    }

    printf("funded: %d minor units held in escrow\n", $funded['amount_minor']);

    // 5. Ship. This starts the shopper's inspection window.
    $shipped = $escrow->transactions->ship($txn['id']);
    printf("marked shipped; status is now %s\n", $shipped['status']);

    // 6. And then you wait. Release is the SHOPPER'S act - there is no method
    // here that could do it - or auto-release fires when the window expires.
    echo "waiting for the shopper to confirm receipt, or for auto-release.\n";
} catch (ValidationError $e) {
    // The error taxonomy in practice: branch on the class, never on the message.
    fwrite(STDERR, "the API refused the request: {$e->getMessage()}\n");
    exit(1);
} catch (ConflictError $e) {
    fwrite(STDERR, "conflict ({$e->errorCode}): {$e->getMessage()}\n");
    fwrite(STDERR, "if this is IDEMPOTENCY_CONFLICT, the key was reused for a different body.\n");
    exit(1);
} catch (EscrowError $e) {
    fwrite(STDERR, sprintf("%s [%s] %s\n", $e::class, $e->errorCode, $e->getMessage()));
    if ($e->requestId !== null) {
        fwrite(STDERR, "request id: {$e->requestId}\n");
    }
    exit(1);
}
