<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Resources;

use Aminitrust\Escrow\HttpClient;
use Aminitrust\Escrow\ListResult;

/**
 * The delivery log - what was sent, what came back, and what is still being
 * retried.
 *
 * Worth reaching for when an endpoint was down: the API retries over about 22
 * hours on its own, but this is how you see what happened and force a specific
 * one through afterwards.
 *
 * @phpstan-import-type WebhookDelivery from \Aminitrust\Escrow\Types
 */
final class WebhookDeliveries
{
    public function __construct(private readonly HttpClient $http)
    {
    }

    /**
     * @return WebhookDelivery
     */
    public function retrieve(string $id): array
    {
        /** @var WebhookDelivery $data */
        $data = $this->http->request('GET', $this->path($id))['data'];

        return $data;
    }

    /**
     * @param array{limit?: int, starting_after?: string, endpoint_id?: string, status?: 'PENDING'|'DELIVERED'|'FAILED'} $params
     *
     * @return ListResult<WebhookDelivery>
     */
    public function list(array $params = []): ListResult
    {
        /** @var ListResult<WebhookDelivery> $result PHPStan cannot infer T from a constructor call. */
        $result = new ListResult($this->http, '/partner/v1/webhook_deliveries', [
            'limit' => $params['limit'] ?? null,
            'starting_after' => $params['starting_after'] ?? null,
            'endpoint_id' => $params['endpoint_id'] ?? null,
            'status' => $params['status'] ?? null,
        ]);

        return $result;
    }

    /**
     * Sends one delivery again.
     *
     * It arrives with the same event id as the original, so a receiver that
     * deduplicates on it - which the API asks you to do - will correctly treat a
     * retry of something already processed as a no-op.
     *
     * @return WebhookDelivery
     */
    public function retry(string $id): array
    {
        /** @var WebhookDelivery $data */
        $data = $this->http->request(
            'POST',
            $this->path($id) . '/retry',
            [],
            null,
            HttpClient::randomIdempotencyKey(),
        )['data'];

        return $data;
    }

    private function path(string $id): string
    {
        return '/partner/v1/webhook_deliveries/' . rawurlencode($id);
    }
}
