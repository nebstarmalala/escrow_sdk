<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

/**
 * 403. Either the partner account is suspended, or the key lacks the scope the
 * route requires (INSUFFICIENT_SCOPE). The second is fixed by issuing a key with
 * more scopes; the first is not fixed by anything you can do in code.
 */
final class PermissionError extends EscrowError
{
}
