<?php

/**
 * The PHP half of the end-to-end harness: the same checks the TypeScript half
 * runs, against the same live backend and the same key.
 *
 * Run through e2e/run.mjs, not directly.
 */

declare(strict_types=1);

require __DIR__ . '/../packages/php/vendor/autoload.php';

use Aminitrust\Escrow\Errors\EscrowError;
use Aminitrust\Escrow\Escrow;

$key = $argv[1] ?? '';
$base = $argv[2] ?? 'http://localhost:8080';

if ($key === '') {
    fwrite(STDERR, "usage: php-lifecycle.php <key> [base]\n");
    exit(2);
}

$escrow = new Escrow(['api_key' => $key, 'base_url' => $base, 'max_retries' => 1]);

if ($escrow->livemode) {
    fwrite(STDERR, "refusing to run: that is a LIVE key\n");
    exit(2);
}

$failures = 0;

function step(string $name, callable $fn): void
{
    global $failures;

    try {
        $detail = $fn();
        printf("  PASS  %s%s\n", $name, $detail === null ? '' : ' - ' . $detail);
    } catch (\Throwable $e) {
        $failures++;
        printf("  FAIL  %s\n        %s\n", $name, $e->getMessage());
    }
}

$orderId = 'e2e_php_' . time();
$phone = '+2547' . substr((string) (time() + 1), -8);
$txnId = null;

step('authenticates and reports test mode', function () use ($escrow): string {
    $me = $escrow->me();
    if ($me['livemode'] !== false) {
        throw new RuntimeException('expected livemode false');
    }

    return 'partner ' . $me['partner_id'];
});

step('creates a transaction', function () use ($escrow, $orderId, $phone, &$txnId): string {
    $result = $escrow->transactions->create([
        'partner_reference' => $orderId,
        'amount_minor' => 250000,
        'title' => 'E2E headphones (php)',
        'description' => 'Created by the SDK end-to-end harness',
        'item_type' => 'PHYSICAL',
        'category' => 'electronics',
        'buyer' => ['phone' => $phone, 'full_name' => 'E2E Shopper'],
        'delivery_method' => 'COURIER',
        'delivery_timeline' => '3-5 days',
        'metadata' => ['harness' => 'e2e'],
    ], $orderId);

    $txnId = $result['transaction']['id'];

    if ($result['transaction']['livemode'] !== false) {
        throw new RuntimeException('a test key produced a live transaction');
    }
    if ($result['replayed'] !== false) {
        throw new RuntimeException('a first create should not be a replay');
    }

    return $result['transaction']['reference'] . ' (' . $result['transaction']['status'] . ')';
});

step('replays an identical create', function () use ($escrow, $orderId, $phone, &$txnId): string {
    $again = $escrow->transactions->create([
        'partner_reference' => $orderId,
        'amount_minor' => 250000,
        'title' => 'E2E headphones (php)',
        'description' => 'Created by the SDK end-to-end harness',
        'item_type' => 'PHYSICAL',
        'category' => 'electronics',
        'buyer' => ['phone' => $phone, 'full_name' => 'E2E Shopper'],
        'delivery_method' => 'COURIER',
        'delivery_timeline' => '3-5 days',
        'metadata' => ['harness' => 'e2e'],
    ], $orderId);

    if ($again['replayed'] !== true) {
        throw new RuntimeException('expected Idempotent-Replay: true');
    }
    if ($again['transaction']['id'] !== $txnId) {
        throw new RuntimeException('replay returned a different transaction');
    }

    return 'same id, Idempotent-Replay: true';
});

step('rejects the same key with a different body', function () use ($escrow, $orderId, $phone): string {
    try {
        $escrow->transactions->create([
            'partner_reference' => $orderId,
            'amount_minor' => 999900,
            'title' => 'E2E headphones (php)',
            'description' => 'Created by the SDK end-to-end harness',
            'item_type' => 'PHYSICAL',
            'category' => 'electronics',
            'buyer' => ['phone' => $phone, 'full_name' => 'E2E Shopper'],
            'delivery_method' => 'COURIER',
            'delivery_timeline' => '3-5 days',
        ], $orderId);
    } catch (EscrowError $e) {
        if ($e->errorCode !== 'IDEMPOTENCY_CONFLICT') {
            throw $e;
        }

        return $e->errorCode;
    }

    throw new RuntimeException('expected a 409');
});

step('retrieves and masks the buyer contact', function () use ($escrow, $phone, &$txnId): string {
    $txn = $escrow->transactions->retrieve((string) $txnId);
    $buyer = json_encode($txn['buyer'] ?? []);

    if (is_string($buyer) && str_contains($buyer, $phone)) {
        throw new RuntimeException('the raw buyer phone came back in the response: ' . $buyer);
    }

    return (string) $buyer;
});

step('lists the transaction through the cursor iterator', function () use ($escrow, &$txnId): string {
    foreach ($escrow->transactions->list(['limit' => 5]) as $txn) {
        if ($txn['id'] === $txnId) {
            return 'found on the first page';
        }
    }

    throw new RuntimeException('the created transaction was not in the list');
});

step('404s on an id that does not exist', function () use ($escrow): string {
    try {
        $escrow->transactions->retrieve('01a05e5c-0000-7000-8000-000000000000');
    } catch (EscrowError $e) {
        if ($e->errorCode !== 'NOT_FOUND') {
            throw $e;
        }

        return $e->errorCode;
    }

    throw new RuntimeException('expected a 404');
});

step('refuses a webhook URL pointing at private space', function () use ($escrow): string {
    try {
        // https, so the scheme check passes and the address check is the
        // thing actually under test.
        $escrow->webhookEndpoints->create(['url' => 'https://169.254.169.254/latest/meta-data/']);
    } catch (EscrowError $e) {
        if ($e->status !== 422) {
            throw $e;
        }

        return $e->errorCode . ': ' . $e->getMessage();
    }

    throw new RuntimeException('the API accepted a link-local webhook URL');
});

exit($failures === 0 ? 0 : 1);
