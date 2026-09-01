<?php

/**
 * A webhook receiver, in plain PHP.
 *
 *   php -S 127.0.0.1:9095 examples/php-plain/webhook.php
 *
 * Point an endpoint at it through a tunnel - the API refuses to deliver to
 * private addresses, and checks that again at DNS resolution time, so a name
 * that resolves to localhost will not work either.
 *
 *   ESCROW_WEBHOOK_SECRET=whsec_xxx php -S 127.0.0.1:9095 examples/php-plain/webhook.php
 */

declare(strict_types=1);

require __DIR__ . '/../../packages/php/vendor/autoload.php';

use Aminitrust\Escrow\Webhooks;
use Aminitrust\Escrow\WebhookSignatureError;

$secret = getenv('ESCROW_WEBHOOK_SECRET');
if ($secret === false || $secret === '') {
    http_response_code(500);
    exit("ESCROW_WEBHOOK_SECRET is not set\n");
}

// The RAW bytes. `php://input` is the right source precisely because it has not
// been decoded and re-encoded: round-tripping through json_decode/json_encode
// changes key order and whitespace, the signature stops matching, and the error
// reads like a wrong secret rather than a body-handling mistake.
$raw = file_get_contents('php://input');
if ($raw === false) {
    http_response_code(400);
    exit;
}

$header = $_SERVER['HTTP_ESCROW_SIGNATURE'] ?? null;

try {
    $event = Webhooks::verify($raw, is_string($header) ? $header : null, $secret);
} catch (WebhookSignatureError $e) {
    // 400, not 500. A 5xx tells the API to retry, and a delivery that cannot be
    // verified will not verify on the fourth attempt either.
    error_log('webhook REJECTED: ' . $e->getMessage());
    http_response_code(400);
    exit;
}

// Acknowledge FIRST, work afterwards. Anything slower than a couple of seconds
// gets retried, and the retry arrives while you are still handling the first
// copy.
http_response_code(200);

// Delivery is at-least-once and UNORDERED. Two consequences:
//
//   - Deduplicate on $event['id'], which is stable across retries and replays.
//   - A transaction.funded can arrive after a transaction.shipped. Treat
//     data.object.status as the truth and use `sequence` to discard a stale
//     update, rather than assuming arrival order reflects what happened.
error_log(sprintf(
    'webhook: %s (id %s, seq %s, livemode %s)',
    $event['type'],
    $event['id'],
    (string) ($event['sequence'] ?? '-'),
    $event['livemode'] ? 'true' : 'false',
));

// A test-mode delivery must never move real stock or real money. The flag is on
// the envelope AND on the object, and they always agree.
if ($event['livemode'] === false) {
    error_log('  (test mode - ignoring for fulfilment purposes)');
    exit;
}

match ($event['type']) {
    'transaction.funded' => error_log('  -> money is held; safe to ship'),
    'transaction.released', 'transaction.completed' => error_log('  -> funds settled to you'),
    'transaction.refunded' => error_log('  -> refunded; restock'),
    'dispute.opened' => error_log('  -> a dispute needs your evidence'),
    default => null,
};
