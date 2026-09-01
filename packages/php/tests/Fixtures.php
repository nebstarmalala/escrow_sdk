<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Tests;

use RuntimeException;

final class Fixtures
{
    /**
     * @return array<string, mixed>
     */
    public static function load(string $name): array
    {
        $path = __DIR__ . '/../../../shared/fixtures/' . $name;
        $raw = file_get_contents($path);

        if ($raw === false) {
            throw new RuntimeException("cannot read fixture: {$path}");
        }

        /** @var array<string, mixed> $decoded */
        $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);

        return $decoded;
    }

    /**
     * Asserts that a case contains no key this implementation does not handle.
     *
     * The fixture contract requires it: a test that loops over cases and quietly
     * ignores the ones it does not recognise will stay green forever after
     * someone adds a case it has never heard of, while reading as coverage.
     *
     * @param array<string, mixed> $case
     * @param list<string>         $known
     */
    public static function assertNoUnknownKeys(array $case, array $known, string $where): void
    {
        $unknown = array_diff(array_keys($case), $known);

        if ($unknown !== []) {
            throw new RuntimeException(sprintf(
                '%s contains %s, which this SDK does not handle. Either implement it or '
                . 'remove it - do not widen the allowed key list to make this pass.',
                $where,
                implode(', ', array_map(static fn (string $k): string => '"' . $k . '"', $unknown)),
            ));
        }
    }
}
