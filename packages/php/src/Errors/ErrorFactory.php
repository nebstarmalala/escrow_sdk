<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Errors;

/**
 * Turns a response into the right error class, and decides what may be retried.
 *
 * Both decisions are pinned by shared/fixtures/errors.json, which the
 * TypeScript SDK and the Go backend run as well. A merchant's catch block
 * should behave identically in either language.
 */
final class ErrorFactory
{
    /**
     * Every code the API can return, mapped to the class it becomes.
     *
     * Exhaustive rather than a match with a default: a code added to the API
     * should surface as an untested mapping here, not silently become a generic
     * error in every merchant's catch block.
     *
     * @var array<string, class-string<EscrowError>>
     */
    private const CODE_TO_CLASS = [
        'VALIDATION_ERROR' => ValidationError::class,
        'UNPROCESSABLE' => ValidationError::class,
        'UNAUTHORIZED' => AuthenticationError::class,
        'FORBIDDEN' => PermissionError::class,
        'INSUFFICIENT_SCOPE' => PermissionError::class,
        'NOT_FOUND' => NotFoundError::class,
        'CONFLICT' => ConflictError::class,
        'IDEMPOTENCY_CONFLICT' => ConflictError::class,
        'INVALID_STATE_TRANSITION' => ConflictError::class,
        'RATE_LIMITED' => RateLimitError::class,
        'INSUFFICIENT_FUNDS' => InsufficientFundsError::class,
        'SERVICE_UNAVAILABLE' => ApiError::class,
        'INTERNAL' => ApiError::class,
    ];

    /**
     * @param array<string, string> $headers lower-cased header names
     */
    public static function fromResponse(int $status, string $rawBody, array $headers): EscrowError
    {
        $requestId = $headers['x-request-id'] ?? null;

        $code = null;
        $message = null;
        $details = null;

        /** @var mixed $parsed */
        $parsed = json_decode($rawBody, true);
        if (is_array($parsed) && isset($parsed['error']) && is_array($parsed['error'])) {
            $error = $parsed['error'];
            $code = is_string($error['code'] ?? null) ? $error['code'] : null;
            $message = is_string($error['message'] ?? null) ? $error['message'] : null;
            $details = is_array($error['details'] ?? null) ? $error['details'] : null;
        }

        if ($code === null || $message === null) {
            // Not an error envelope: a gateway answering instead of the API.
            // The body can be a whole HTML page, so a fragment is enough to
            // recognise it without flooding a log line.
            $trimmed = trim($rawBody);
            $suffix = $trimmed === '' ? '' : ': ' . mb_substr($trimmed, 0, 200);

            return new ApiError(
                $code ?? 'INTERNAL',
                $message ?? sprintf('unexpected response from the API (HTTP %d)%s', $status, $suffix),
                $status,
                null,
                $requestId,
            );
        }

        if ($code === 'RATE_LIMITED') {
            $header = $headers['retry-after'] ?? null;
            $seconds = ($header !== null && ctype_digit($header)) ? (int) $header : null;

            return new RateLimitError($code, $message, $status, $details, $requestId, $seconds);
        }

        $class = self::CODE_TO_CLASS[$code] ?? ApiError::class;

        return new $class($code, $message, $status, $details, $requestId);
    }

    /**
     * Whether the SDK's own retry loop may repeat a request.
     *
     * Narrow on purpose. Only 429, 5xx and transport failures qualify; every
     * 409 is handed back to the caller.
     */
    public static function isRetryable(EscrowError $error): bool
    {
        if ($error instanceof ConnectionError) {
            return true;
        }
        if ($error instanceof RateLimitError) {
            return true;
        }

        return $error->status >= 500;
    }
}
