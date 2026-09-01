<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

use RuntimeException;
use Throwable;

/**
 * Base class for everything this SDK throws.
 *
 * The subclasses carry the meaning. Catching this one is the coarse handler;
 * catching RateLimitError should never require matching on a message, which the
 * API documents as rewordable at any time.
 *
 * Named *Error rather than *Exception on purpose: these names are the shared
 * contract in shared/fixtures/errors.json, and the TypeScript SDK uses them
 * too. One document describes both.
 */
class EscrowError extends RuntimeException
{
    /**
     * @param array<string, mixed>|null $details
     */
    public function __construct(
        public readonly string $errorCode,
        string $message,
        /** HTTP status, or 0 when the request never got a response. */
        public readonly int $status,
        public readonly ?array $details = null,
        /** The API's request id, when it sent one. Quote it in a support ticket. */
        public readonly ?string $requestId = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, $status, $previous);
    }
}
