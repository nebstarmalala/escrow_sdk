<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Resources;

use Aminitrust\Escrow\HttpClient;
use Aminitrust\Escrow\ListResult;

/**
 * Read-only, and deliberately so.
 *
 * There is no endpoint for a merchant to open a dispute. A dispute is the
 * shopper's instrument; one raised "on behalf of" them by the party holding the
 * goods is a fraud vector, not a convenience.
 *
 * @phpstan-import-type Dispute from \Aminitrust\Escrow\Types
 */
final class Disputes
{
    public function __construct(private readonly HttpClient $http)
    {
    }

    /**
     * @return Dispute
     */
    public function retrieve(string $id): array
    {
        /** @var Dispute $data */
        $data = $this->http->request(
            'GET',
            '/partner/v1/disputes/' . rawurlencode($id),
        )['data'];

        return $data;
    }

    /**
     * @param array{limit?: int, starting_after?: string, status?: string} $params
     *
     * @return ListResult<Dispute>
     */
    public function list(array $params = []): ListResult
    {
        /** @var ListResult<Dispute> $result PHPStan cannot infer T from a constructor call. */
        $result = new ListResult($this->http, '/partner/v1/disputes', [
            'limit' => $params['limit'] ?? null,
            'starting_after' => $params['starting_after'] ?? null,
            'status' => $params['status'] ?? null,
        ]);

        return $result;
    }
}
