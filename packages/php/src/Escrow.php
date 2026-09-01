<?php

declare(strict_types=1);

namespace Aminitrust\Escrow;

/**
 * Escrow Partner API client.
 *
 * Server-side only. A secret key must never reach a browser: it can move a
 * merchant's money, and there is no origin check that makes shipping one to a
 * front-end safe.
 */
final class Escrow
{
    /** This package's version. */
    public const VERSION = '1.0.0';

    /**
     * The API version this package speaks.
     *
     * Pinned deliberately: /partner/v1 is frozen at 1.0.0, and a bump here
     * should be a conscious act, not a side effect of a release script.
     */
    public const API_VERSION = '1.0.0';
}
