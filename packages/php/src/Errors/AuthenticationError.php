<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

/**
 * 401. Missing, malformed, unknown, expired, or wrong-mode key.
 *
 * The API returns an identical body for all of those on purpose, so that the
 * response cannot be used to probe for valid keys. Nothing here can tell you
 * which it was.
 */
final class AuthenticationError extends EscrowError
{
}
