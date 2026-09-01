<?php

declare(strict_types=1);

namespace Aminitrust\Escrow;

use Aminitrust\Escrow\Errors\ConnectionError;
use Aminitrust\Escrow\Errors\ErrorFactory;
use Aminitrust\Escrow\Errors\EscrowError;
use Http\Discovery\Psr17FactoryDiscovery;
use Http\Discovery\Psr18ClientDiscovery;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * The request pipeline: auth, retries, idempotency, error mapping.
 *
 * PSR-18 rather than a hard dependency on Guzzle. A merchant integrating this
 * already has an HTTP client and a version of it they are stuck with; making
 * them install a second one - and resolve its conflicts with the first - is how
 * a package becomes the reason an upgrade is deferred.
 */
final class HttpClient
{
    private const RETRY_BASE_MS = 500;
    private const RETRY_CAP_MS = 8000;

    private ClientInterface $client;
    private RequestFactoryInterface $requests;
    private StreamFactoryInterface $streams;

    public function __construct(
        private readonly string $apiKey,
        private readonly string $baseUrl,
        private readonly int $maxRetries,
        private readonly string $userAgent,
        ?ClientInterface $client = null,
        ?RequestFactoryInterface $requests = null,
        ?StreamFactoryInterface $streams = null,
    ) {
        // Discovery finds whatever PSR-18 client the host application already
        // has. Passing one explicitly is how the test suite substitutes a
        // recording client, and how an integrator supplies a configured one
        // (proxy, mTLS, corporate egress).
        $this->client = $client ?? Psr18ClientDiscovery::find();
        $this->requests = $requests ?? Psr17FactoryDiscovery::findRequestFactory();
        $this->streams = $streams ?? Psr17FactoryDiscovery::findStreamFactory();
    }

    /**
     * @param array<string, scalar|null>  $query
     * @param array<string, mixed>|null   $body
     *
     * @return array{data: mixed, status: int, replayed: bool, requestId: ?string}
     */
    public function request(
        string $method,
        string $path,
        array $query = [],
        ?array $body = null,
        ?string $idempotencyKey = null,
    ): array {
        $url = $this->buildUrl($path, $query);
        $encoded = $body === null ? null : self::encodeBody($body);

        $lastError = null;

        for ($attempt = 0; $attempt <= $this->maxRetries; $attempt++) {
            if ($attempt > 0) {
                usleep(self::backoffMicroseconds($attempt, $lastError));
            }

            try {
                return $this->attempt($method, $url, $encoded, $idempotencyKey);
            } catch (EscrowError $error) {
                if (!ErrorFactory::isRetryable($error)) {
                    throw $error;
                }
                $lastError = $error;
            }
        }

        // Every attempt was retryable, and every attempt failed.
        throw $lastError ?? new ConnectionError('the request failed with no error recorded');
    }

    /**
     * @return array{data: mixed, status: int, replayed: bool, requestId: ?string}
     */
    private function attempt(
        string $method,
        string $url,
        ?string $body,
        ?string $idempotencyKey,
    ): array {
        $request = $this->requests->createRequest($method, $url)
            ->withHeader('Authorization', 'Bearer ' . $this->apiKey)
            ->withHeader('Accept', 'application/json')
            ->withHeader('User-Agent', $this->userAgent);

        if ($idempotencyKey !== null) {
            $request = $request->withHeader('Idempotency-Key', $idempotencyKey);
        }

        if ($body !== null) {
            $request = $request
                ->withHeader('Content-Type', 'application/json')
                ->withBody($this->streams->createStream($body));
        }

        try {
            $response = $this->client->sendRequest($request);
        } catch (ClientExceptionInterface $e) {
            throw new ConnectionError('could not reach the API: ' . $e->getMessage(), $e);
        }

        $status = $response->getStatusCode();
        // Read as a string, always. A gateway answering instead of the API
        // sends HTML, and decoding that as JSON first throws an error that
        // tells the merchant nothing about what happened.
        $raw = (string) $response->getBody();

        $headers = [];
        foreach ($response->getHeaders() as $name => $values) {
            $headers[strtolower($name)] = implode(',', $values);
        }

        if ($status >= 400) {
            throw ErrorFactory::fromResponse($status, $raw, $headers);
        }

        return [
            'data' => trim($raw) === '' ? null : json_decode($raw, true, 512, JSON_THROW_ON_ERROR),
            'status' => $status,
            'replayed' => ($headers['idempotent-replay'] ?? null) === 'true',
            'requestId' => $headers['x-request-id'] ?? null,
        ];
    }

    /**
     * @param array<string, scalar|null> $query
     */
    private function buildUrl(string $path, array $query): string
    {
        $filtered = array_filter($query, static fn ($v): bool => $v !== null);
        if ($filtered === []) {
            return $this->baseUrl . $path;
        }

        return $this->baseUrl . $path . '?' . http_build_query($filtered);
    }

    /**
     * @param array<string, mixed> $body
     */
    private static function encodeBody(array $body): string
    {
        // A null value is dropped rather than sent. The API distinguishes an
        // absent property from an explicit null, and rejects an unrecognised
        // one outright, so "not supplied" has to mean absent.
        $clean = array_filter($body, static fn ($v): bool => $v !== null);

        // An empty body must still be "{}" and not "[]": PHP cannot tell an
        // empty list from an empty map, and json_encode([]) produces an array,
        // which the API rejects as the wrong type.
        return $clean === [] ? '{}' : (string) json_encode($clean, JSON_THROW_ON_ERROR);
    }

    /**
     * Full jitter, capped, with the API's own Retry-After taking precedence.
     *
     * Full jitter rather than exponential-plus-a-little: when a shared
     * dependency recovers, every client that backed off in lockstep returns in
     * lockstep and knocks it over again.
     */
    private static function backoffMicroseconds(int $attempt, ?EscrowError $lastError): int
    {
        if ($lastError instanceof Errors\RateLimitError && $lastError->retryAfterSeconds !== null) {
            return max(0, $lastError->retryAfterSeconds) * 1_000_000;
        }

        $ceilingMs = (int) min(self::RETRY_CAP_MS, self::RETRY_BASE_MS * (2 ** ($attempt - 1)));

        return random_int(0, $ceilingMs) * 1000;
    }

    /**
     * A UUIDv4 for use as an idempotency key.
     *
     * random_bytes rather than uniqid or mt_rand: a weak idempotency key
     * silently stops being idempotent, and the failure mode is a shopper
     * charged twice.
     */
    public static function randomIdempotencyKey(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
