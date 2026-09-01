<?php

declare(strict_types=1);

namespace Aminitrust\Escrow;

use Generator;
use IteratorAggregate;

/**
 * A lazily-paged list.
 *
 * `foreach ($escrow->transactions->list() as $txn)` walks every page; the next
 * request is only made when the current page runs out, so breaking out of the
 * loop early costs nothing.
 *
 * The API pages on `starting_after` rather than an offset, so a page boundary
 * cannot drift while you walk it: new objects appear at the front, and the
 * cursor is anchored to the last id you actually saw.
 *
 * @template T of array<string, mixed>
 *
 * @implements IteratorAggregate<int, T>
 */
final class ListResult implements IteratorAggregate
{
    /**
     * @param array<string, scalar|null> $query
     */
    public function __construct(
        private readonly HttpClient $http,
        private readonly string $path,
        private readonly array $query = [],
    ) {
    }

    /**
     * Fetches exactly one page, for callers driving the cursor themselves.
     *
     * @return array{object: string, data: list<T>, has_more: bool, next_cursor?: ?string}
     */
    public function page(?string $cursor = null): array
    {
        $query = $this->query;
        if ($cursor !== null) {
            $query['starting_after'] = $cursor;
        }

        /** @var array{object: string, data: list<T>, has_more: bool, next_cursor?: ?string} $data */
        $data = $this->http->request('GET', $this->path, $query)['data'];

        return $data;
    }

    /**
     * @return Generator<int, T>
     */
    public function getIterator(): Generator
    {
        $cursor = null;
        $startingAfter = $this->query['starting_after'] ?? null;
        if (is_string($startingAfter)) {
            $cursor = $startingAfter;
        }

        $guard = 0;

        while (true) {
            $page = $this->page($cursor);

            foreach ($page['data'] as $item) {
                yield $item;
            }

            if ($page['has_more'] !== true) {
                return;
            }

            $next = $page['next_cursor'] ?? null;

            // has_more without a usable cursor would otherwise spin forever on
            // the same page. Stopping is the honest response: the alternative
            // is an integration that looks like it is working while it refetches
            // page one.
            if (!is_string($next) || $next === '' || $next === $cursor) {
                return;
            }

            $cursor = $next;

            // A server bug that always reports another page would hang a
            // merchant's checkout rather than fail it.
            if (++$guard > 10000) {
                throw new \RuntimeException(sprintf(
                    'pagination did not terminate after %d pages of %s; this is a bug in the API, not in your code',
                    $guard,
                    $this->path,
                ));
            }
        }
    }

    /**
     * Collects every page into one array.
     *
     * Convenient, and a liability on a large account: it holds the whole list in
     * memory and cannot start work until the last page arrives. Prefer
     * iterating.
     *
     * @return list<T>
     */
    public function all(): array
    {
        return iterator_to_array($this->getIterator(), false);
    }
}
