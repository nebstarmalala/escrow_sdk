<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

use Throwable;

/**
 * The request never completed: DNS failure, connection reset, timeout.
 *
 * `status` is 0 because there was no response at all. Safe to retry, and the
 * SDK does.
 */
final class ConnectionError extends EscrowError
{
    public function __construct(string $message, ?Throwable $previous = null)
    {
        parent::__construct('CONNECTION_ERROR', $message, 0, null, null, $previous);
    }
}
