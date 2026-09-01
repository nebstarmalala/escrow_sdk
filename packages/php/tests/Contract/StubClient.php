<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Tests\Contract;

use GuzzleHttp\Psr7\Response;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use RuntimeException;

/**
 * A PSR-18 client that replays a scripted sequence of responses and records
 * every request it was given.
 *
 * The PHP side substitutes at the PSR-18 seam rather than standing up a socket:
 * unlike the TypeScript SDK, nothing here implements HTTP itself, so a real
 * server would be testing Guzzle rather than this package. What IS worth
 * testing is that the right method, path, headers and body go into the
 * interface - and that is exactly what this captures.
 */
final class StubClient implements ClientInterface
{
    /** @var list<RequestInterface> */
    public array $requests = [];

    /** @var list<array{status: int, body: string, headers: array<string, string>}> */
    private array $script = [];

    private ?\Throwable $throw = null;

    /** @var array{status: int, body: string, headers: array<string, string>} */
    private array $fallback = [
        'status' => 500,
        'body' => '{"error":{"code":"INTERNAL","message":"stub ran out of scripted replies"}}',
        'headers' => [],
    ];

    /**
     * @param array<string, mixed>|string $body
     * @param array<string, string>       $headers
     */
    public function push(int $status, array|string $body = '', array $headers = []): self
    {
        $this->script[] = [
            'status' => $status,
            'body' => is_string($body) ? $body : (string) json_encode($body),
            'headers' => $headers,
        ];

        return $this;
    }

    /**
     * @param array<string, mixed>|string $body
     * @param array<string, string>       $headers
     */
    public function always(int $status, array|string $body = '', array $headers = []): self
    {
        $this->fallback = [
            'status' => $status,
            'body' => is_string($body) ? $body : (string) json_encode($body),
            'headers' => $headers,
        ];

        return $this;
    }

    /** Makes the next send throw, simulating a connection failure. */
    public function failWith(\Throwable $e): self
    {
        $this->throw = $e;

        return $this;
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $this->requests[] = $request;

        if ($this->throw !== null) {
            $e = $this->throw;
            if (!$e instanceof ClientExceptionInterface) {
                throw new RuntimeException('failWith needs a ClientExceptionInterface', 0, $e);
            }
            throw $e;
        }

        $reply = array_shift($this->script) ?? $this->fallback;

        return new Response($reply['status'], $reply['headers'] + ['Content-Type' => 'application/json'], $reply['body']);
    }

    public function lastBody(): string
    {
        $last = $this->requests[array_key_last($this->requests)] ?? null;
        if ($last === null) {
            throw new RuntimeException('no requests were made');
        }

        return (string) $last->getBody();
    }
}
