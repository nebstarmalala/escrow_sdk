<?php

declare(strict_types=1);

namespace Aminitrust\Escrow;

use Aminitrust\Escrow\Errors\EscrowError;

/** Thrown when a delivery cannot be trusted. Never catch this and continue. */
final class WebhookSignatureError extends EscrowError
{
    public function __construct(string $message)
    {
        parent::__construct('WEBHOOK_SIGNATURE_INVALID', $message, 0);
    }
}
