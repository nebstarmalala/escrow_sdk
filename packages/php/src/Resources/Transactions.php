<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Resources;

use Aminitrust\Escrow\HttpClient;
use Aminitrust\Escrow\ListResult;

/**
 * There is deliberately no `release` method here, and there must never be one.
 *
 * Funds move when the shopper confirms receipt or the inspection timer expires.
 * That the merchant cannot decide it is the product, not a policy an SDK should
 * be able to soften. A test asserts no method matching /release/ exists.
 *
 * @phpstan-import-type Transaction from \Aminitrust\Escrow\Types
 * @phpstan-import-type CreateTransactionRequest from \Aminitrust\Escrow\Types
 * @phpstan-import-type CreateTransactionResponse from \Aminitrust\Escrow\Types
 * @phpstan-import-type PaymentRequest from \Aminitrust\Escrow\Types
 * @phpstan-import-type RefundRequest from \Aminitrust\Escrow\Types
 * @phpstan-import-type Payment from \Aminitrust\Escrow\Types
 *
 * The two money-moving calls return a wrapper carrying `replayed` alongside
 * the object, rather than merging the flag into the object itself. A stray
 * boolean sitting among a transaction's own fields is the kind of thing that
 * ends up serialised into a merchant's database by accident. The TypeScript
 * SDK returns the same shape, so one document describes both.
 */
final class Transactions
{
    public function __construct(private readonly HttpClient $http)
    {
    }

    /**
     * Creates an escrow for an order, and optionally charges the shopper.
     *
     * Two outcomes, and both must be handled:
     *
     * - The shopper is new to escrow, so the transaction is auto-accepted on
     *   your attestation and `payment` describes the charge.
     * - The shopper already has an escrow account, so the transaction stays
     *   `pending_acceptance`, `payment` is null, and NOTHING HAS BEEN CHARGED.
     *   They accept in their own app. This is not an error and does not throw;
     *   an integration that ignores it has orders that silently never fund.
     *
     * Record the returned id against your order *before* you rely on it. If
     * this call times out, the escrow may well exist.
     *
     * $idempotencyKey should be a value unique per logical request and reused on
     * retry - your own order id works well. One is generated if you omit it,
     * which is safe within this call but not across a process restart: if your
     * job runs again, a generated key is a different key, and a different key is
     * a second escrow.
     *
     * @param CreateTransactionRequest $params
     *
     * @return array{transaction: Transaction, payment: Payment|null, replayed: bool}
     */
    public function create(array $params, ?string $idempotencyKey = null): array
    {
        $response = $this->http->request(
            'POST',
            '/partner/v1/transactions',
            [],
            $params,
            $idempotencyKey ?? HttpClient::randomIdempotencyKey(),
        );

        /** @var CreateTransactionResponse $data */
        $data = $response['data'];

        return [
            'transaction' => $data['transaction'],
            'payment' => $data['payment'] ?? null,
            'replayed' => $response['replayed'],
        ];
    }

    /**
     * @return Transaction
     */
    public function retrieve(string $id): array
    {
        /** @var Transaction $data */
        $data = $this->http->request('GET', $this->path($id))['data'];

        return $data;
    }

    /**
     * Newest first, scoped to this key's partner and mode.
     *
     * @param array{limit?: int, starting_after?: string, status?: string} $params
     *
     * @return ListResult<Transaction>
     */
    public function list(array $params = []): ListResult
    {
        /** @var ListResult<Transaction> $result PHPStan cannot infer T from a constructor call. */
        $result = new ListResult($this->http, '/partner/v1/transactions', [
            'limit' => $params['limit'] ?? null,
            'starting_after' => $params['starting_after'] ?? null,
            'status' => $params['status'] ?? null,
        ]);

        return $result;
    }

    /**
     * Marks the item shipped, which starts the shopper's inspection window.
     *
     * Only valid from `funded`. Calling it earlier is a 409, not a no-op.
     *
     * @return Transaction
     */
    public function ship(string $id, ?string $idempotencyKey = null): array
    {
        return $this->action($id, 'ship', null, $idempotencyKey);
    }

    /**
     * Cancels an escrow that has not been funded.
     *
     * Once money is held this is a 409 - use refund(). Cancelling a funded
     * escrow would leave the shopper's money with nowhere to go, which is why
     * the API refuses rather than guessing.
     *
     * @return Transaction
     */
    public function cancel(string $id, ?string $idempotencyKey = null): array
    {
        return $this->action($id, 'cancel', null, $idempotencyKey);
    }

    /**
     * Starts or retries the charge on an `accepted` transaction.
     *
     * This is the call for a create that came back with payment.status ==
     * 'failed'. Creating a second transaction instead is the mistake it exists
     * to prevent: the first escrow is still there, still accepted, and still
     * counted.
     *
     * @param PaymentRequest $params
     *
     * @return Transaction
     */
    public function pay(string $id, array $params, ?string $idempotencyKey = null): array
    {
        return $this->action($id, 'payments', $params, $idempotencyKey);
    }

    /**
     * Returns the escrowed principal to the shopper, in full.
     *
     * The counterpart to there being no release endpoint: you can always give
     * money back, never take it. The funding fee is not returned - it paid for
     * escrow already rendered.
     *
     * A transaction already under dispute cannot be refunded this way; that is
     * the mediator's decision.
     *
     * @param RefundRequest $params
     *
     * @return array{transaction: Transaction, replayed: bool}
     */
    public function refund(string $id, array $params = [], ?string $idempotencyKey = null): array
    {
        $response = $this->http->request(
            'POST',
            $this->path($id) . '/refund',
            [],
            $params,
            $idempotencyKey ?? HttpClient::randomIdempotencyKey(),
        );

        /** @var Transaction $data */
        $data = $response['data'];

        return ['transaction' => $data, 'replayed' => $response['replayed']];
    }

    /**
     * @param array<string, mixed>|null $body
     *
     * @return Transaction
     */
    private function action(string $id, string $action, ?array $body, ?string $key): array
    {
        /** @var Transaction $data */
        $data = $this->http->request(
            'POST',
            $this->path($id) . '/' . $action,
            [],
            $body,
            // Optional on these routes rather than required, but always sent:
            // the cost is a header, and the alternative is a retried timeout
            // shipping twice or starting a second STK prompt.
            $key ?? HttpClient::randomIdempotencyKey(),
        )['data'];

        return $data;
    }

    private function path(string $id): string
    {
        // Encoded, not interpolated. A caller passing an id straight from their
        // own database should not be able to walk out of the resource.
        return '/partner/v1/transactions/' . rawurlencode($id);
    }
}
