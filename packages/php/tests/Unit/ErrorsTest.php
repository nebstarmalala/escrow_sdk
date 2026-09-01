<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Tests\Unit;

use Aminitrust\Escrow\Errors\ApiError;
use Aminitrust\Escrow\Errors\ConnectionError;
use Aminitrust\Escrow\Errors\ErrorFactory;
use Aminitrust\Escrow\Errors\RateLimitError;
use Aminitrust\Escrow\Tests\Fixtures;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ErrorsTest extends TestCase
{
    private const KNOWN_KEYS = [
        'name', 'why', 'http_status', 'headers', 'body', 'raw_body',
        'error_class', 'retryable', 'retry_after_seconds',
    ];

    /**
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function cases(): iterable
    {
        /** @var list<array<string, mixed>> $cases */
        $cases = Fixtures::load('errors.json')['cases'];

        foreach ($cases as $case) {
            /** @var string $name */
            $name = $case['name'];
            yield $name => [$case];
        }
    }

    /**
     * @param array<string, mixed> $case
     */
    #[DataProvider('cases')]
    public function testMapsEveryFixtureCase(array $case): void
    {
        Fixtures::assertNoUnknownKeys($case, self::KNOWN_KEYS, 'errors.json case');

        /** @var string $className */
        $className = $case['error_class'];
        $expected = 'Aminitrust\\Escrow\\Errors\\' . $className;
        self::assertTrue(class_exists($expected), "no SDK class named {$className}");

        /** @var int $status */
        $status = $case['http_status'] ?? 500;

        $raw = isset($case['raw_body'])
            ? (string) $case['raw_body']
            : (string) json_encode($case['body']);

        /** @var array<string, string> $headers */
        $headers = [];
        /** @var array<string, string> $given */
        $given = $case['headers'] ?? [];
        foreach ($given as $name => $value) {
            $headers[strtolower($name)] = $value;
        }

        $error = ErrorFactory::fromResponse($status, $raw, $headers);

        self::assertInstanceOf($expected, $error);
        self::assertSame($status, $error->status);
        self::assertSame($case['retryable'], ErrorFactory::isRetryable($error));

        if (isset($case['body']) && is_array($case['body'])) {
            /** @var array{error: array{code: string, message: string}} $body */
            $body = $case['body'];
            self::assertSame($body['error']['code'], $error->errorCode);
            self::assertSame($body['error']['message'], $error->getMessage());
        }

        if (isset($case['retry_after_seconds'])) {
            self::assertInstanceOf(RateLimitError::class, $error);
            self::assertSame($case['retry_after_seconds'], $error->retryAfterSeconds);
        }
    }

    public function testTurnsATransportFailureIntoARetryableConnectionError(): void
    {
        // No HTTP response exists, so status is 0 rather than a made-up 5xx.
        $error = new ConnectionError('connect ECONNREFUSED');

        self::assertSame(0, $error->status);
        self::assertTrue(ErrorFactory::isRetryable($error));
    }

    public function testDoesNotChokeOnAnUnrecognisedCode(): void
    {
        // A code added to the API before this SDK is updated. It must still
        // produce a usable error rather than throwing while building one.
        $error = ErrorFactory::fromResponse(
            418,
            (string) json_encode(['error' => ['code' => 'SOMETHING_NEW', 'message' => 'a future code']]),
            [],
        );

        self::assertInstanceOf(ApiError::class, $error);
        self::assertSame('SOMETHING_NEW', $error->errorCode);
        self::assertFalse(ErrorFactory::isRetryable($error));
    }

    public function testSurfacesTheRequestId(): void
    {
        $error = ErrorFactory::fromResponse(
            404,
            (string) json_encode(['error' => ['code' => 'NOT_FOUND', 'message' => 'transaction not found']]),
            ['x-request-id' => 'req_abc123'],
        );

        self::assertSame('req_abc123', $error->requestId);
    }

    public function testHasAFixtureForEveryCodeItClaimsToMap(): void
    {
        /** @var list<array<string, mixed>> $cases */
        $cases = Fixtures::load('errors.json')['cases'];

        $covered = [];
        foreach ($cases as $case) {
            if (isset($case['body']) && is_array($case['body'])) {
                /** @var array{error: array{code: string}} $body */
                $body = $case['body'];
                $covered[$body['error']['code']] = true;
            }
        }

        $claimed = [
            'VALIDATION_ERROR', 'UNPROCESSABLE', 'UNAUTHORIZED', 'FORBIDDEN',
            'INSUFFICIENT_SCOPE', 'NOT_FOUND', 'CONFLICT', 'IDEMPOTENCY_CONFLICT',
            'INVALID_STATE_TRANSITION', 'RATE_LIMITED', 'INSUFFICIENT_FUNDS',
            'SERVICE_UNAVAILABLE', 'INTERNAL',
        ];

        foreach ($claimed as $code) {
            self::assertArrayHasKey($code, $covered, "no fixture covers {$code}");
        }
    }
}
