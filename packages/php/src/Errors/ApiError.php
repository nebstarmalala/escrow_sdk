<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

/**
 * 5xx, an unparseable body, or anything else unrecognised.
 *
 * A 502 from a proxy has no error envelope at all, and an SDK that assumes one
 * throws a JSON parse error that tells the merchant nothing.
 */
final class ApiError extends EscrowError
{
}
