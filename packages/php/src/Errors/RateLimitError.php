<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

/**
 * 429. The per-key quota was exceeded.
 *
 * `retryAfterSeconds` is the API's own instruction. Prefer it to guessing: the
 * SDK's backoff is a fallback for when the header is absent, never an override
 * of it.
 */
final class RateLimitError extends EscrowError
{
    /**
     * The extra parameter goes LAST, not next to the status it relates to.
     *
     * ErrorFactory builds most errors through `new $class(...)` off a
     * code-to-class map that includes this one, so every constructor in the
     * family has to accept the same first five arguments. Putting
     * retryAfterSeconds in the middle makes that generic construction a type
     * error - which is how this was caught.
     *
     * @param array<string, mixed>|null $details
     */
    public function __construct(
        string $errorCode,
        string $message,
        int $status,
        ?array $details = null,
        ?string $requestId = null,
        public readonly ?int $retryAfterSeconds = null,
    ) {
        parent::__construct($errorCode, $message, $status, $details, $requestId);
    }
}
