<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

/**
 * 404. No such object *for this key*.
 *
 * Also what you get for an object belonging to another partner or the other mode
 * - a live key asking about a test transaction included. Deliberately not a 403,
 * so the response cannot confirm that an id exists.
 */
final class NotFoundError extends EscrowError
{
}
