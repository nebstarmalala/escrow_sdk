import { describe, expect, it } from 'vitest';

import {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  type EscrowError,
  InsufficientFundsError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ValidationError,
} from '../../src/errors.js';
import { errorFromResponse, isRetryable } from '../../src/errors.js';
import { assertNoUnknownKeys, loadFixture } from '../fixtures.js';

interface ErrorCase {
  name: string;
  why?: string;
  http_status?: number;
  headers?: Record<string, string>;
  body?: { error: { code: string; message: string; details?: Record<string, unknown> } };
  raw_body?: string;
  error_class: string;
  retryable: boolean;
  retry_after_seconds?: number;
}

interface ErrorFixtures {
  $schema_version: number;
  $description: string;
  $notes: Record<string, string>;
  cases: ErrorCase[];
}

const CLASSES: Record<string, new (...args: never[]) => EscrowError> = {
  ValidationError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InsufficientFundsError,
  ApiError,
};

const KNOWN_CASE_KEYS = [
  'name',
  'why',
  'http_status',
  'headers',
  'body',
  'raw_body',
  'error_class',
  'retryable',
  'retry_after_seconds',
] as const;

const fx = loadFixture<ErrorFixtures>('errors.json');

describe('errors.json', () => {
  it('is a schema version this SDK understands', () => {
    expect(fx.$schema_version).toBe(1);
    expect(fx.cases.length).toBeGreaterThan(0);
  });

  it.each(fx.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    assertNoUnknownKeys(
      c as unknown as Record<string, unknown>,
      KNOWN_CASE_KEYS,
      `errors.json case "${c.name}"`,
    );

    const expected = CLASSES[c.error_class];
    expect(expected, `no SDK class named "${c.error_class}"`).toBeDefined();

    const raw = c.raw_body ?? JSON.stringify(c.body);
    const headers = new Headers(c.headers ?? {});
    const err = errorFromResponse(c.http_status ?? 500, raw, headers);

    expect(err).toBeInstanceOf(expected as new (...args: never[]) => EscrowError);
    expect(err.status).toBe(c.http_status ?? 500);
    expect(isRetryable(err)).toBe(c.retryable);

    if (c.body !== undefined) {
      expect(err.code).toBe(c.body.error.code);
      expect(err.message).toBe(c.body.error.message);
    }

    if (c.retry_after_seconds !== undefined) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSeconds).toBe(c.retry_after_seconds);
    }
  });

  // The fixture file is the shared contract; the SDK's own table is what it
  // promises merchants. A code in one and not the other means someone's catch
  // block is about to receive a generic ApiError it was not written for.
  it('has a fixture for every code the SDK claims to map', () => {
    const mapped = new Set(
      fx.cases.filter((c) => c.body !== undefined).map((c) => c.body!.error.code),
    );

    const claimed = [
      'VALIDATION_ERROR',
      'UNPROCESSABLE',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'INVALID_STATE_TRANSITION',
      'RATE_LIMITED',
      'INSUFFICIENT_FUNDS',
      'SERVICE_UNAVAILABLE',
      'INTERNAL',
    ];

    for (const code of claimed) {
      expect(mapped.has(code), `no fixture covers ${code}`).toBe(true);
    }
  });
});

describe('errors the fixtures cannot express', () => {
  it('turns a transport failure into a retryable ConnectionError', () => {
    // No HTTP response exists, so status is 0 rather than a made-up 5xx.
    const err = new ConnectionError('connect ECONNREFUSED');
    expect(err.status).toBe(0);
    expect(isRetryable(err)).toBe(true);
  });

  it('does not choke on an error envelope carrying an unrecognised code', () => {
    // A code added to the API before this SDK is updated. It must still produce
    // a usable error rather than throwing while building one.
    const err = errorFromResponse(
      418,
      JSON.stringify({ error: { code: 'SOMETHING_NEW', message: 'a future code' } }),
      new Headers(),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('SOMETHING_NEW');
    expect(err.message).toBe('a future code');
    expect(isRetryable(err)).toBe(false);
  });

  it('surfaces the request id when the API sends one', () => {
    const err = errorFromResponse(
      404,
      JSON.stringify({ error: { code: 'NOT_FOUND', message: 'transaction not found' } }),
      new Headers({ 'X-Request-Id': 'req_abc123' }),
    );
    expect(err.requestId).toBe('req_abc123');
  });

  it('keeps instanceof working through the class hierarchy', () => {
    const err = errorFromResponse(
      429,
      JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }),
      new Headers({ 'Retry-After': '7' }),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(7);
    expect(err.name).toBe('RateLimitError');
  });
});
