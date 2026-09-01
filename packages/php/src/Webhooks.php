<?php

declare(strict_types=1);

namespace Aminitrust\Escrow;

use DateTimeImmutable;
use DateTimeInterface;

/**
 * Webhook signature verification.
 *
 * Stateless, so no API key is needed - a webhook receiver often has the signing
 * secret and nothing else.
 *
 * @phpstan-import-type WebhookEvent from \Aminitrust\Escrow\Types
 */
final class Webhooks
{
    private const DEFAULT_TOLERANCE_SECONDS = 300;

    /**
     * Verifies a delivery and returns the parsed event.
     *
     * $rawBody MUST be the exact bytes the API sent. Not a decoded array, not an
     * array re-encoded with json_encode: round-tripping through JSON changes key
     * order and whitespace, the MAC stops matching, and the resulting error looks
     * like a wrong secret rather than a body-handling mistake. This is the single
     * most common integration bug against this API.
     *
     * Getting the raw body:
     *
     *   plain PHP    file_get_contents('php://input')
     *   Laravel      $request->getContent()
     *   Symfony      $request->getContent()
     *   Slim / PSR-7 (string) $request->getBody()
     *
     * Throws rather than returning a boolean, deliberately: a merchant who
     * forgets to check a returned flag has no verification at all, and that
     * failure is silent.
     *
     * @return WebhookEvent
     */
    public static function verify(
        string $rawBody,
        ?string $signatureHeader,
        string $secret,
        int $toleranceSeconds = self::DEFAULT_TOLERANCE_SECONDS,
        ?DateTimeInterface $now = null,
    ): array {
        if ($signatureHeader === null || $signatureHeader === '') {
            throw new WebhookSignatureError(
                'no Escrow-Signature header. Check your framework is not stripping unknown '
                . 'headers, and that this route is not behind a proxy that drops them.',
            );
        }

        if (!str_starts_with($secret, 'whsec_')) {
            throw new WebhookSignatureError(
                'the signing secret should begin with "whsec_". An API key (sk_live_... / '
                . 'sk_test_...) is a different thing and will never verify.',
            );
        }

        [$timestamp, $signatures] = self::parseHeader($signatureHeader);

        if ($timestamp === null) {
            throw new WebhookSignatureError(
                sprintf('no timestamp in the signature header: "%s"', $signatureHeader),
            );
        }
        if ($signatures === []) {
            throw new WebhookSignatureError(
                sprintf('no v1 signature in the header: "%s"', $signatureHeader),
            );
        }

        $nowSeconds = ($now ?? new DateTimeImmutable())->getTimestamp();
        $age = $nowSeconds - $timestamp;

        // Both directions. A clock far ahead is as suspect as one far behind,
        // and checking only for staleness is the usual half-implementation.
        if ($age > $toleranceSeconds || $age < -$toleranceSeconds) {
            throw new WebhookSignatureError(sprintf(
                'the delivery\'s timestamp is %ds away from now, outside the %ds tolerance. '
                . 'This is either a replayed request or a clock that needs fixing.',
                $age,
                $toleranceSeconds,
            ));
        }

        $expected = self::computeSignature($secret, (string) $timestamp, $rawBody);

        // Any signature may match: during a rotation the API sends one per
        // active secret, so a receiver holding either the new or the old one
        // still verifies. No early exit on the first match, so the work done is
        // the same either way.
        $matched = false;
        foreach ($signatures as $candidate) {
            if (hash_equals($expected, $candidate)) {
                $matched = true;
            }
        }

        if (!$matched) {
            throw new WebhookSignatureError(
                'the signature does not match. The usual cause is a re-serialised body: '
                . 'verification needs the raw bytes, before any JSON decoding.',
            );
        }

        /** @var mixed $decoded */
        $decoded = json_decode($rawBody, true);
        if (!is_array($decoded)) {
            throw new WebhookSignatureError('the body verified but is not valid JSON');
        }

        /** @var WebhookEvent $decoded */
        return $decoded;
    }

    /**
     * Builds a signature header. For testing your own handler.
     *
     * Nothing in a merchant's production path signs anything - this exists so a
     * webhook route can be exercised in a test suite without a live delivery.
     *
     * @param list<string> $secrets
     */
    public static function signPayload(array $secrets, DateTimeInterface $timestamp, string $body): string
    {
        $ts = (string) $timestamp->getTimestamp();

        $parts = ['t=' . $ts];
        foreach ($secrets as $secret) {
            if ($secret === '') {
                continue;
            }
            $parts[] = 'v1=' . self::computeSignature($secret, $ts, $body);
        }

        return implode(',', $parts);
    }

    /**
     * @return array{0: ?int, 1: list<string>}
     */
    private static function parseHeader(string $header): array
    {
        $timestamp = null;
        $signatures = [];

        foreach (explode(',', $header) as $rawPart) {
            // Trimmed because proxies reformat header values, and a leading
            // space would otherwise turn "v1=..." into an unrecognised part.
            $part = trim($rawPart);

            if (str_starts_with($part, 't=')) {
                $value = substr($part, 2);
                if (ctype_digit($value)) {
                    $timestamp = (int) $value;
                }
            } elseif (str_starts_with($part, 'v1=')) {
                $signatures[] = substr($part, 3);
            }
        }

        return [$timestamp, $signatures];
    }

    private static function computeSignature(string $secret, string $ts, string $body): string
    {
        // "<timestamp>.<body>", never the body alone. With the timestamp inside
        // the MAC, a captured delivery cannot be replayed onto a fresh
        // timestamp - which is what makes the tolerance check worth anything.
        return hash_hmac('sha256', $ts . '.' . $body, $secret);
    }
}
