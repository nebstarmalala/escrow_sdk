<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

/**
 * 409. CONFLICT, IDEMPOTENCY_CONFLICT, or INVALID_STATE_TRANSITION.
 *
 * The SDK never retries these automatically. IDEMPOTENCY_CONFLICT means the key
 * is bound to a different request and repeating it can only fail again; plain
 * CONFLICT may be safe to repeat after a wait, but it also covers a duplicate
 * partner_reference, and auto-retrying would paper over a duplicate-order bug.
 */
final class ConflictError extends EscrowError
{
}
