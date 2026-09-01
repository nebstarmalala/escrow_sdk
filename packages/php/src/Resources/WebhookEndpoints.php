<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Resources;

use Aminitrust\Escrow\HttpClient;
use Aminitrust\Escrow\ListResult;

/**
 * @phpstan-import-type WebhookEndpoint from \Aminitrust\Escrow\Types
 * @phpstan-import-type WebhookEndpointWithSecret from \Aminitrust\Escrow\Types
 * @phpstan-import-type CreateWebhookEndpointRequest from \Aminitrust\Escrow\Types
 * @phpstan-import-type UpdateWebhookEndpointRequest from \Aminitrust\Escrow\Types
 */
final class WebhookEndpoints
{
    public function __construct(private readonly HttpClient $http)
    {
    }

    /**
     * Registers an endpoint.
     *
     * The response is the ONLY time the signing secret is returned. Store it
     * before you do anything else with the value; there is no endpoint that will
     * show it to you again, only one that replaces it.
     *
     * The URL must be https and must not resolve to a private address. That is
     * checked here and again at delivery time, because a DNS name that passes
     * registration can be repointed afterwards.
     *
     * @param CreateWebhookEndpointRequest $params
     *
     * @return WebhookEndpointWithSecret
     */
    public function create(array $params, ?string $idempotencyKey = null): array
    {
        /** @var WebhookEndpointWithSecret $data */
        $data = $this->http->request(
            'POST',
            '/partner/v1/webhook_endpoints',
            [],
            $params,
            $idempotencyKey ?? HttpClient::randomIdempotencyKey(),
        )['data'];

        return $data;
    }

    /**
     * @return WebhookEndpoint
     */
    public function retrieve(string $id): array
    {
        /** @var WebhookEndpoint $data */
        $data = $this->http->request('GET', $this->path($id))['data'];

        return $data;
    }

    /**
     * @param array{limit?: int, starting_after?: string} $params
     *
     * @return ListResult<WebhookEndpoint>
     */
    public function list(array $params = []): ListResult
    {
        /** @var ListResult<WebhookEndpoint> $result PHPStan cannot infer T from a constructor call. */
        $result = new ListResult($this->http, '/partner/v1/webhook_endpoints', [
            'limit' => $params['limit'] ?? null,
            'starting_after' => $params['starting_after'] ?? null,
        ]);

        return $result;
    }

    /**
     * @param UpdateWebhookEndpointRequest $params
     *
     * @return WebhookEndpoint
     */
    public function update(string $id, array $params): array
    {
        /** @var WebhookEndpoint $data */
        $data = $this->http->request('PATCH', $this->path($id), [], $params)['data'];

        return $data;
    }

    /** Permanent. Deliveries already queued for it stop. */
    public function delete(string $id): void
    {
        $this->http->request('DELETE', $this->path($id));
    }

    /**
     * Issues a new signing secret and returns it once.
     *
     * The previous secret keeps working for a grace window, during which every
     * delivery carries two v1 signatures - one per secret. That is what makes a
     * rotation deployable: verify with either, deploy the new one, and no
     * delivery is dropped in between.
     *
     * @return WebhookEndpointWithSecret
     */
    public function rotateSecret(string $id): array
    {
        /** @var WebhookEndpointWithSecret $data */
        $data = $this->http->request(
            'POST',
            $this->path($id) . '/rotate_secret',
            [],
            null,
            HttpClient::randomIdempotencyKey(),
        )['data'];

        return $data;
    }

    private function path(string $id): string
    {
        return '/partner/v1/webhook_endpoints/' . rawurlencode($id);
    }
}
