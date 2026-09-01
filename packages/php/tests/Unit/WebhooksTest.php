<?php

declare(strict_types=1);

namespace Aminitrust\Escrow\Tests\Unit;

use Aminitrust\Escrow\Tests\Fixtures;
use Aminitrust\Escrow\Webhooks;
use Aminitrust\Escrow\WebhookSignatureError;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

final class WebhooksTest extends TestCase
{
    private const SECRET = 'whsec_testsecrettestsecrettestsecrettestsecret';
    private const BODY = '{"id":"evt_1","type":"transaction.funded"}';

    private const SIGN_KEYS = ['name', 'why', 'secrets', 'timestamp', 'body', 'expected_header'];
    private const VERIFY_KEYS = [
        'name', 'why', 'secret', 'header', 'body', 'now', 'tolerance_seconds', 'expected',
    ];

    /**
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function signCases(): iterable
    {
        /** @var list<array<string, mixed>> $cases */
        $cases = Fixtures::load('signatures.json')['sign'];

        foreach ($cases as $case) {
            /** @var string $name */
            $name = $case['name'];
            yield $name => [$case];
        }
    }

    /**
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function verifyCases(): iterable
    {
        /** @var list<array<string, mixed>> $cases */
        $cases = Fixtures::load('signatures.json')['verify'];

        foreach ($cases as $case) {
            /** @var string $name */
            $name = $case['name'];
            yield $name => [$case];
        }
    }

    /**
     * @param array<string, mixed> $case
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('signCases')]
    public function testSignMatchesTheSharedVector(array $case): void
    {
        Fixtures::assertNoUnknownKeys($case, self::SIGN_KEYS, 'signatures.json sign case');

        /** @var list<string> $secrets */
        $secrets = $case['secrets'];
        /** @var int $timestamp */
        $timestamp = $case['timestamp'];
        /** @var string $body */
        $body = $case['body'];

        $header = Webhooks::signPayload(
            $secrets,
            (new DateTimeImmutable())->setTimestamp($timestamp),
            $body,
        );

        self::assertSame($case['expected_header'], $header, (string) ($case['why'] ?? ''));
    }

    /**
     * @param array<string, mixed> $case
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('verifyCases')]
    public function testVerifyMatchesTheSharedVector(array $case): void
    {
        Fixtures::assertNoUnknownKeys($case, self::VERIFY_KEYS, 'signatures.json verify case');

        /** @var string $secret */
        $secret = $case['secret'];
        /** @var string $header */
        $header = $case['header'];
        /** @var string $body */
        $body = $case['body'];
        /** @var int $now */
        $now = $case['now'];
        /** @var int $tolerance */
        $tolerance = $case['tolerance_seconds'];

        $verify = static fn (): array => Webhooks::verify(
            $body,
            $header,
            $secret,
            $tolerance,
            (new DateTimeImmutable())->setTimestamp($now),
        );

        if ($case['expected'] === true) {
            // A verified event always carries its id, so this asserts the
            // body came back parsed rather than merely not throwing.
            self::assertArrayHasKey('id', $verify(), (string) ($case['why'] ?? ''));

            return;
        }

        $this->expectException(WebhookSignatureError::class);
        $verify();
    }

    public function testNamesTheReserialisedBodyAsTheLikelyCause(): void
    {
        $at = (new DateTimeImmutable())->setTimestamp(1755820800);
        $header = Webhooks::signPayload([self::SECRET], $at, self::BODY);

        // What a merchant does when they let their framework decode JSON first:
        // same data, different bytes.
        $reserialised = (string) json_encode(json_decode(self::BODY, true));

        $this->expectException(WebhookSignatureError::class);
        $this->expectExceptionMessageMatches('/raw bytes/');

        Webhooks::verify($reserialised . ' ', $header, self::SECRET, 300, $at);
    }

    public function testRejectsAnApiKeyUsedAsASigningSecret(): void
    {
        $at = (new DateTimeImmutable())->setTimestamp(1755820800);
        $header = Webhooks::signPayload([self::SECRET], $at, self::BODY);

        $this->expectException(WebhookSignatureError::class);
        $this->expectExceptionMessageMatches('/whsec_/');

        Webhooks::verify(self::BODY, $header, 'sk_test_' . str_repeat('a', 43), 300, $at);
    }

    public function testRejectsAMissingHeaderRatherThanTreatingItAsUnsigned(): void
    {
        $this->expectException(WebhookSignatureError::class);
        $this->expectExceptionMessageMatches('/no Escrow-Signature header/');

        Webhooks::verify(self::BODY, null, self::SECRET);
    }

    public function testVerifiesABodyWhoseBytesAreNotAscii(): void
    {
        // Where a character-length-based implementation silently diverges - and
        // it diverges only for merchants whose product titles are not ASCII.
        $at = (new DateTimeImmutable())->setTimestamp(1755820800);

        // A PHP string is already bytes, so this literal is the UTF-8 encoding
        // of the text. That is precisely why PHP gets this right by default and
        // JavaScript does not - and why the shared fixture pins it for both.
        //
        // Shaped as a real event rather than a bare object, so the returned type
        // is the one a merchant actually receives.
        $body = '{"id":"evt_café_☕_naïve","object":"event","type":"transaction.funded",'
            . '"created":1755820800,"livemode":false,"data":{"object":{}}}';
        $header = Webhooks::signPayload([self::SECRET], $at, $body);

        $event = Webhooks::verify($body, $header, self::SECRET, 300, $at);
        self::assertSame('evt_café_☕_naïve', $event['id']);
    }

    public function testReportsAVerifiedBodyThatIsNotJsonDistinctly(): void
    {
        $at = (new DateTimeImmutable())->setTimestamp(1755820800);
        $notJson = 'this verified but is not json';
        $header = Webhooks::signPayload([self::SECRET], $at, $notJson);

        $this->expectException(WebhookSignatureError::class);
        $this->expectExceptionMessageMatches('/verified but is not valid JSON/');

        Webhooks::verify($notJson, $header, self::SECRET, 300, $at);
    }

    /**
     * Every event fixture must survive a signed round trip.
     */
    public function testRoundTripsEveryEventFixture(): void
    {
        /** @var list<array<string, mixed>> $events */
        $events = Fixtures::load('events.json')['events'];
        self::assertNotEmpty($events);

        $at = (new DateTimeImmutable())->setTimestamp(1755820800);

        foreach ($events as $event) {
            $raw = (string) json_encode($event);
            $header = Webhooks::signPayload([self::SECRET], $at, $raw);

            $parsed = Webhooks::verify($raw, $header, self::SECRET, 300, $at);

            self::assertSame($event['id'], $parsed['id']);
            self::assertSame($event['type'], $parsed['type']);
            self::assertSame($event['livemode'], $parsed['livemode']);
        }
    }
}
