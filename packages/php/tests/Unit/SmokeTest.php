<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Tests\Unit;

use Aminitrust\Escrow\Escrow;
use PHPUnit\Framework\TestCase;

final class SmokeTest extends TestCase
{
    public function testReportsTheApiVersionItWasBuiltAgainst(): void
    {
        self::assertSame('1.0.0', Escrow::API_VERSION);
        self::assertMatchesRegularExpression('/^\d+\.\d+\.\d+/', Escrow::VERSION);
    }
}
