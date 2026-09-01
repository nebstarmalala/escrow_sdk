<?php

declare(strict_types=1);

namespace Aminitrust\Escrow;

use Aminitrust\Escrow\Resources\Disputes;
use Aminitrust\Escrow\Resources\Transactions;
use Aminitrust\Escrow\Resources\WebhookDeliveries;
use Aminitrust\Escrow\Resources\WebhookEndpoints;
use InvalidArgumentException;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * The Escrow Partner API client.
 *
 * Server-side only. A secret key can move a merchant's money, and there is no
 * origin check that makes shipping one to a browser safe.
 *
 * @phpstan-import-type Me from \Aminitrust\Escrow\Types
 */
final class Escrow
{
    /** This package's version. */
    public const VERSION = '1.0.0';

    /** The API version this package speaks. */
    public const API_VERSION = '1.0.0';

    public const DEFAULT_BASE_URL = 'https://api.escrow.co.ke';

    private const LIVE_PREFIX = 'sk_live_';
    private const TEST_PREFIX = 'sk_test_';

    /**
     * Whether this key moves real money, read from the key itself with no
     * network call.
     *
     * Available before the first request on purpose. Discovering at checkout
     * time that you deployed a test key - or worse, a live one - is too late,
     * and a boot-time assertion is the cheapest guard there is:
     *
     *     if (!$escrow->livemode && $env === 'production') {
     *         throw new RuntimeException('refusing to start with a test key');
     *     }
     */
    public readonly bool $livemode;

    public readonly string $baseUrl;

    public readonly Transactions $transactions;
    public readonly Disputes $disputes;
    public readonly WebhookEndpoints $webhookEndpoints;
    public readonly WebhookDeliveries $webhookDeliveries;

    private readonly HttpClient $http;

    /**
     * @param array{
     *   api_key: string,
     *   base_url?: string,
     *   max_retries?: int,
     * } $options
     */
    public function __construct(
        array $options,
        ?ClientInterface $client = null,
        ?RequestFactoryInterface $requests = null,
        ?StreamFactoryInterface $streams = null,
    ) {
        $apiKey = trim($options['api_key'] ?? '');

        if ($apiKey === '') {
            throw new InvalidArgumentException(
                'an API key is required. Pass one as ["api_key" => ...], from a secret store '
                . 'or an environment variable - never a literal in source.',
            );
        }

        if (str_starts_with($apiKey, self::LIVE_PREFIX)) {
            $this->livemode = true;
        } elseif (str_starts_with($apiKey, self::TEST_PREFIX)) {
            $this->livemode = false;
        } else {
            // Fail here rather than on the first 401. A key that is a truncated
            // copy, a webhook secret, or an admin token is a configuration
            // mistake, and the API deliberately returns an identical 401 for
            // every one of those - so the server can never tell you which.
            throw new InvalidArgumentException(sprintf(
                'that does not look like a partner API key: it should begin with "%s" or "%s". '
                . 'A webhook signing secret (whsec_...) is a different thing and cannot be used here.',
                self::LIVE_PREFIX,
                self::TEST_PREFIX,
            ));
        }

        $this->baseUrl = rtrim($options['base_url'] ?? self::DEFAULT_BASE_URL, '/');

        $this->http = new HttpClient(
            $apiKey,
            $this->baseUrl,
            $options['max_retries'] ?? 2,
            sprintf('escrow-sdk-php/%s php/%s', self::VERSION, PHP_VERSION),
            $client,
            $requests,
            $streams,
        );

        $this->transactions = new Transactions($this->http);
        $this->disputes = new Disputes($this->http);
        $this->webhookEndpoints = new WebhookEndpoints($this->http);
        $this->webhookDeliveries = new WebhookDeliveries($this->http);
    }

    /**
     * Confirms the key works, and reports its partner, scopes and quota.
     *
     * @return Me
     */
    public function me(): array
    {
        /** @var Me $data */
        $data = $this->http->request('GET', '/partner/v1/me')['data'];

        return $data;
    }

    /**
     * Escape hatch for an endpoint this SDK does not wrap yet, and the only way
     * to see the full response envelope - status, request id, and whether the
     * API replayed a stored response.
     *
     * @param array<string, scalar|null> $query
     * @param array<string, mixed>|null  $body
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
        return $this->http->request($method, $path, $query, $body, $idempotencyKey);
    }

    /** @internal Resources and tests use this; not part of the supported surface. */
    public function transport(): HttpClient
    {
        return $this->http;
    }
}
