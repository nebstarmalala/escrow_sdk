<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Tests\Contract;

use Aminitrust\Escrow\Errors\ApiError;
use Aminitrust\Escrow\Errors\ConflictError;
use Aminitrust\Escrow\Errors\ConnectionError;
use Aminitrust\Escrow\Errors\RateLimitError;
use Aminitrust\Escrow\Escrow;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Psr7\HttpFactory;
use GuzzleHttp\Psr7\Request;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    private const TEST_KEY = 'sk_test_sdk_placeholder';
    private const LIVE_KEY = 'sk_live_sdk_placeholder';

    private const ME = [
        'object' => 'partner',
        'partner_id' => '0199a3f2-6c1e-7c8e-9f2a-3b4c5d6e7f80',
        'key_prefix' => 'aaaaaaaaaaaa',
        'livemode' => false,
        'scopes' => ['transactions:read'],
        'rate_limit_per_min' => 120,
        'time' => '2026-09-01T09:00:00Z',
    ];

    private const TXN = [
        'id' => '0199a3f2-6c1e-7c8e-9f2a-3b4c5d6e7f80',
        'object' => 'transaction',
        'reference' => 'ESC-8H2K4M',
        'status' => 'funded',
        'amount_minor' => 250000,
        'fee_minor' => 7500,
        'payable_minor' => 257500,
        'currency' => 'KES',
        'livemode' => false,
        'created_at' => '2026-09-01T09:12:41Z',
        'updated_at' => '2026-09-01T09:15:04Z',
    ];

    private const PARAMS = [
        'partner_reference' => 'order_10245',
        'amount_minor' => 250000,
        'title' => 'Sony WH-1000XM5',
        'description' => 'Wireless headphones',
        'item_type' => 'PHYSICAL',
        'category' => 'electronics',
        'buyer' => ['phone' => '+254700111222'],
        'delivery_method' => 'COURIER',
        'delivery_timeline' => '3-5 days',
    ];

    private function client(StubClient $stub, int $maxRetries = 0): Escrow
    {
        $factory = new HttpFactory();

        return new Escrow(
            ['api_key' => self::TEST_KEY, 'base_url' => 'https://api.test', 'max_retries' => $maxRetries],
            $stub,
            $factory,
            $factory,
        );
    }

    // --- construction ----------------------------------------------------

    public function testReadsLivemodeFromTheKeyWithNoNetworkCall(): void
    {
        $factory = new HttpFactory();
        $stub = new StubClient();

        self::assertTrue((new Escrow(['api_key' => self::LIVE_KEY], $stub, $factory, $factory))->livemode);
        self::assertFalse((new Escrow(['api_key' => self::TEST_KEY], $stub, $factory, $factory))->livemode);
        self::assertSame([], $stub->requests);
    }

    public function testRefusesAnythingThatIsNotAPartnerKey(): void
    {
        // The API returns an identical 401 for every kind of bad key, so it can
        // never tell you which mistake you made. Catching the shape here is the
        // only place a useful message is possible.
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/whsec_/');

        $factory = new HttpFactory();
        new Escrow(['api_key' => 'whsec_abc'], new StubClient(), $factory, $factory);
    }

    public function testNormalisesATrailingSlashOnBaseUrl(): void
    {
        $factory = new HttpFactory();
        $escrow = new Escrow(
            ['api_key' => self::TEST_KEY, 'base_url' => 'http://localhost:8080/'],
            new StubClient(),
            $factory,
            $factory,
        );

        self::assertSame('http://localhost:8080', $escrow->baseUrl);
    }

    // --- transport -------------------------------------------------------

    public function testSendsTheKeyAsABearerToken(): void
    {
        $stub = (new StubClient())->push(200, self::ME);
        $this->client($stub)->me();

        self::assertSame('Bearer ' . self::TEST_KEY, $stub->requests[0]->getHeaderLine('Authorization'));
        self::assertMatchesRegularExpression(
            '#^escrow-sdk-php/\d+\.\d+\.\d+#',
            $stub->requests[0]->getHeaderLine('User-Agent'),
        );
    }

    public function testRetriesA5xxAndReturnsTheEventualSuccess(): void
    {
        $stub = (new StubClient())
            ->push(500, ['error' => ['code' => 'INTERNAL', 'message' => 'boom']])
            ->push(500, ['error' => ['code' => 'INTERNAL', 'message' => 'boom']])
            ->push(200, self::ME);

        $me = $this->client($stub, maxRetries: 2)->me();

        self::assertSame(self::ME['partner_id'], $me['partner_id']);
        self::assertCount(3, $stub->requests);
    }

    public function testDoesNotRetryA4xx(): void
    {
        $stub = (new StubClient())->always(409, [
            'error' => ['code' => 'IDEMPOTENCY_CONFLICT', 'message' => 'key bound to another request'],
        ]);

        try {
            $this->client($stub, maxRetries: 2)->transactions->create(self::PARAMS);
            self::fail('expected a ConflictError');
        } catch (ConflictError) {
            // The whole point: repeating this can only fail again, and a retry
            // loop that treats every 409 as transient turns one mistake into
            // three.
            self::assertCount(1, $stub->requests);
        }
    }

    public function testHonoursRetryAfterOnA429(): void
    {
        $stub = (new StubClient())
            ->push(429, ['error' => ['code' => 'RATE_LIMITED', 'message' => 'slow down']], ['Retry-After' => '0'])
            ->push(200, self::ME);

        $started = microtime(true);
        $this->client($stub, maxRetries: 1)->me();

        self::assertCount(2, $stub->requests);
        // Retry-After: 0 means the SDK used the API's instruction; its own
        // jittered backoff would have slept.
        self::assertLessThan(0.4, microtime(true) - $started);
    }

    public function testSurfacesA429ThatNeverClears(): void
    {
        $stub = (new StubClient())->always(
            429,
            ['error' => ['code' => 'RATE_LIMITED', 'message' => 'slow down']],
            ['Retry-After' => '0'],
        );

        try {
            $this->client($stub, maxRetries: 1)->me();
            self::fail('expected a RateLimitError');
        } catch (RateLimitError $e) {
            self::assertSame(0, $e->retryAfterSeconds);
        }
    }

    public function testTurnsAGatewayHtmlPageIntoAUsableError(): void
    {
        $stub = (new StubClient())->always(502, '<html><head><title>502 Bad Gateway</title></head></html>');

        try {
            $this->client($stub)->me();
            self::fail('expected an ApiError');
        } catch (ApiError $e) {
            // Not a JSON decode failure, which is what an SDK that assumes an
            // error envelope produces - and which tells the merchant nothing.
            self::assertStringContainsString('502', $e->getMessage());
            self::assertSame(502, $e->status);
        }
    }

    public function testTurnsATransportFailureIntoAConnectionError(): void
    {
        $stub = (new StubClient())->failWith(
            new ConnectException('connect ECONNREFUSED', new Request('GET', 'https://api.test')),
        );

        $this->expectException(ConnectionError::class);
        $this->client($stub)->me();
    }

    // --- request encoding ------------------------------------------------

    public function testOmitsNullPropertiesRatherThanSendingThem(): void
    {
        $stub = (new StubClient())->push(200, []);

        $this->client($stub)->request('POST', '/partner/v1/transactions', [], [
            'title' => 'thing',
            'delivery_address' => null,
        ]);

        /** @var array<string, mixed> $sent */
        $sent = json_decode($stub->lastBody(), true);

        // The API rejects an unrecognised property rather than ignoring it, and
        // it distinguishes absent from null.
        self::assertSame(['title' => 'thing'], $sent);
    }

    public function testEncodesAnEmptyBodyAsAnObjectNotAnArray(): void
    {
        $stub = (new StubClient())->push(200, self::TXN);

        $this->client($stub)->transactions->refund(self::TXN['id']);

        // PHP cannot tell an empty list from an empty map, and json_encode([])
        // produces "[]", which the API rejects as the wrong type.
        self::assertSame('{}', $stub->lastBody());
    }

    public function testDropsNullQueryParameters(): void
    {
        $stub = (new StubClient())->push(200, ['object' => 'list', 'data' => [], 'has_more' => false]);

        $this->client($stub)->transactions->list(['limit' => 25])->all();

        self::assertSame('limit=25', $stub->requests[0]->getUri()->getQuery());
    }

    // --- idempotency -----------------------------------------------------

    public function testSendsTheSameKeyOnEveryRetryOfOneLogicalRequest(): void
    {
        $stub = (new StubClient())
            ->push(500, ['error' => ['code' => 'INTERNAL', 'message' => 'boom']])
            ->push(500, ['error' => ['code' => 'INTERNAL', 'message' => 'boom']])
            ->push(201, ['transaction' => self::TXN, 'payment' => null]);

        $this->client($stub, maxRetries: 2)->transactions->create(self::PARAMS, 'order_10245');

        $keys = array_map(
            static fn ($r): string => $r->getHeaderLine('Idempotency-Key'),
            $stub->requests,
        );

        self::assertCount(3, $keys);
        // A fresh key per attempt would create three escrows and fire three
        // M-Pesa prompts at one shopper.
        self::assertCount(1, array_unique($keys));
        self::assertSame('order_10245', $keys[0]);
    }

    public function testGeneratesAnIdempotencyKeyWhenNoneIsGiven(): void
    {
        $stub = (new StubClient())->push(201, ['transaction' => self::TXN, 'payment' => null]);

        $this->client($stub)->transactions->create(self::PARAMS);

        self::assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
            $stub->requests[0]->getHeaderLine('Idempotency-Key'),
        );
    }

    public function testReportsAReplayedResponse(): void
    {
        $stub = (new StubClient())->push(
            201,
            ['transaction' => self::TXN, 'payment' => null],
            ['Idempotent-Replay' => 'true'],
        );

        $result = $this->client($stub)->transactions->create(self::PARAMS, 'order_1');

        self::assertTrue($result['replayed']);
    }

    // --- create outcomes -------------------------------------------------

    public function testReturnsPaymentNullForAShopperWhoAlreadyHasAnAccount(): void
    {
        $stub = (new StubClient())->push(201, [
            'transaction' => ['status' => 'pending_acceptance'] + self::TXN,
            'payment' => null,
        ]);

        $result = $this->client($stub)->transactions->create(self::PARAMS);

        // Not an error, and it does not throw. The escrow exists, nothing has
        // been charged, and the shopper accepts in their own app. An integration
        // that ignores this branch has orders that silently never fund.
        self::assertSame('pending_acceptance', $result['transaction']['status']);
        self::assertNull($result['payment']);
    }

    public function testReturnsAFailedPaymentWithoutThrowing(): void
    {
        $stub = (new StubClient())->push(201, [
            'transaction' => ['status' => 'accepted'] + self::TXN,
            'payment' => ['object' => 'payment', 'status' => 'failed'],
        ]);

        $result = $this->client($stub)->transactions->create(self::PARAMS);

        // The escrow exists and is accepted. Throwing here would strand it.
        // Presence is checked first because the spec marks no Payment
        // property as required - which PHPStan is right to insist on, and
        // which a merchant reading payment.status blind would discover the
        // hard way.
        $payment = $result['payment'];
        self::assertNotNull($payment);
        self::assertSame('failed', $payment['status'] ?? null);
    }

    // --- routing ---------------------------------------------------------

    public function testActionsPostToTheRightSubResource(): void
    {
        $stub = (new StubClient())->always(200, self::TXN);
        $escrow = $this->client($stub);
        $id = self::TXN['id'];

        $escrow->transactions->ship($id);
        $escrow->transactions->cancel($id);
        $escrow->transactions->pay($id, ['method' => 'mpesa', 'phone' => '+254700111222']);
        $escrow->transactions->refund($id, ['reason' => 'out of stock']);

        $paths = array_map(
            static fn ($r): string => $r->getMethod() . ' ' . $r->getUri()->getPath(),
            $stub->requests,
        );

        self::assertSame([
            "POST /partner/v1/transactions/{$id}/ship",
            "POST /partner/v1/transactions/{$id}/cancel",
            "POST /partner/v1/transactions/{$id}/payments",
            "POST /partner/v1/transactions/{$id}/refund",
        ], $paths);
    }

    public function testEscapesAnIdRatherThanSplicingItIntoThePath(): void
    {
        $stub = (new StubClient())->always(404, ['error' => ['code' => 'NOT_FOUND', 'message' => 'no']]);

        try {
            $this->client($stub)->transactions->retrieve('../me');
        } catch (\Throwable) {
            // The 404 is expected; the path is what is under test.
        }

        // A caller passing an id straight from their own database should not be
        // able to walk out of the resource.
        self::assertSame(
            '/partner/v1/transactions/..%2Fme',
            $stub->requests[0]->getUri()->getPath(),
        );
    }

    public function testExposesNoMethodThatCouldReleaseFunds(): void
    {
        // Structural, not a comment. Buyer-only release is the product: the
        // shopper's confidence rests on the merchant being unable to decide it.
        $methods = get_class_methods(\Aminitrust\Escrow\Resources\Transactions::class);
        $release = array_filter($methods, static fn (string $m): bool => stripos($m, 'release') !== false);

        self::assertSame([], $release);
    }

    // --- pagination ------------------------------------------------------

    public function testWalksEveryPageExactlyOnce(): void
    {
        $stub = (new StubClient())
            ->push(200, ['object' => 'list', 'data' => [['id' => 'a'], ['id' => 'b']], 'has_more' => true, 'next_cursor' => 'b'])
            ->push(200, ['object' => 'list', 'data' => [['id' => 'c']], 'has_more' => false, 'next_cursor' => null]);

        $seen = [];
        foreach ($this->client($stub)->transactions->list() as $txn) {
            $seen[] = $txn['id'];
        }

        self::assertSame(['a', 'b', 'c'], $seen);
        self::assertCount(2, $stub->requests);
        self::assertStringContainsString('starting_after=b', $stub->requests[1]->getUri()->getQuery());
    }

    public function testStopsFetchingWhenTheCallerBreaksOut(): void
    {
        $stub = (new StubClient())
            ->push(200, ['object' => 'list', 'data' => [['id' => 'a'], ['id' => 'b']], 'has_more' => true, 'next_cursor' => 'b'])
            ->always(500, ['error' => ['code' => 'INTERNAL', 'message' => 'a second page was fetched']]);

        foreach ($this->client($stub)->transactions->list() as $txn) {
            self::assertSame('a', $txn['id']);
            break;
        }

        // Lazy paging is the point: a merchant scanning for one transaction
        // should not pull their whole history to find it.
        self::assertCount(1, $stub->requests);
    }

    public function testTerminatesWhenTheApiClaimsAnotherPageButSendsNoCursor(): void
    {
        // A server bug. Looping on it would refetch page one forever while
        // looking like healthy progress.
        $stub = (new StubClient())->always(200, [
            'object' => 'list', 'data' => [['id' => 'a']], 'has_more' => true, 'next_cursor' => null,
        ]);

        $all = $this->client($stub)->transactions->list()->all();

        self::assertCount(1, $all);
        self::assertCount(1, $stub->requests);
    }
}
