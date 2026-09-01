import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Escrow } from '../../src/client.js';
import { ApiError, ConflictError, ConnectionError, RateLimitError } from '../../src/errors.js';
import { StubServer } from './stub.js';

const TEST_KEY = 'sk_test_' + 'a'.repeat(43);

let stub: StubServer;
let baseUrl: string;

beforeEach(async () => {
  stub = new StubServer();
  baseUrl = await stub.start();
});

afterEach(async () => {
  await stub.stop();
});

function client(overrides: { maxRetries?: number; timeoutMs?: number } = {}): Escrow {
  return new Escrow({
    apiKey: TEST_KEY,
    baseUrl,
    maxRetries: overrides.maxRetries ?? 2,
    // Short by default: these tests should not spend real seconds sleeping.
    timeoutMs: overrides.timeoutMs ?? 2_000,
  });
}

const ME = {
  object: 'partner',
  partner_id: '0199a3f2-6c1e-7c8e-9f2a-3b4c5d6e7f80',
  key_prefix: 'aaaaaaaaaaaa',
  livemode: false,
  scopes: ['transactions:read'],
  rate_limit_per_min: 120,
  time: '2026-09-01T09:00:00Z',
};

describe('authentication', () => {
  it('sends the key as a bearer token', async () => {
    stub.script({ status: 200, body: ME });
    await client().me();

    expect(stub.requests[0]!.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
  });

  it('identifies itself in the User-Agent', async () => {
    stub.script({ status: 200, body: ME });
    await client().me();

    expect(stub.requests[0]!.headers['user-agent']).toMatch(/^escrow-sdk-node\/\d+\.\d+\.\d+/);
  });
});

describe('retries', () => {
  it('retries a 5xx and returns the eventual success', async () => {
    stub.script(
      { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      { status: 200, body: ME },
    );

    const me = await client().me();

    expect(me.partner_id).toBe(ME.partner_id);
    expect(stub.requests).toHaveLength(3);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    stub.then({ status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } } });

    await expect(client({ maxRetries: 2 }).me()).rejects.toBeInstanceOf(ApiError);
    expect(stub.requests).toHaveLength(3);
  });

  it('does not retry a 4xx', async () => {
    stub.then({
      status: 409,
      body: { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'key bound to another request' } },
    });

    await expect(
      client().request({ method: 'POST', path: '/partner/v1/transactions', body: {} }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The whole point: repeating this can only fail again, and a retry loop
    // that treats every 409 as transient turns one mistake into four.
    expect(stub.requests).toHaveLength(1);
  });

  it('honours Retry-After on a 429 rather than its own backoff', async () => {
    stub.script(
      {
        status: 429,
        headers: { 'Retry-After': '0', 'RateLimit-Limit': '120', 'RateLimit-Remaining': '0' },
        body: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
      },
      { status: 200, body: ME },
    );

    const started = Date.now();
    await client().me();

    expect(stub.requests).toHaveLength(2);
    // Retry-After: 0 means the SDK used the API's instruction; its own jittered
    // backoff would have slept.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('surfaces a 429 that never clears as a RateLimitError', async () => {
    stub.then({
      status: 429,
      headers: { 'Retry-After': '0' },
      body: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
    });

    const err = await client({ maxRetries: 1 }).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(0);
  });

  it('turns a timeout into a retryable ConnectionError', async () => {
    stub.then({ status: 200, body: ME, delayMs: 300 });

    const err = await client({ timeoutMs: 50, maxRetries: 0 })
      .me()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).status).toBe(0);
    expect((err as ConnectionError).message).toContain('timed out');
  });
});

describe('idempotency', () => {
  it('sends the same key on every retry of one logical request', async () => {
    stub.script(
      { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      { status: 201, body: { transaction: {}, payment: null } },
    );

    await client().request({
      method: 'POST',
      path: '/partner/v1/transactions',
      body: { partner_reference: 'order_1' },
      idempotencyKey: 'order_1',
    });

    const keys = stub.requests.map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(3);
    // A fresh key per attempt would create three escrows and fire three M-Pesa
    // prompts at one shopper. This assertion is the reason the retry loop
    // computes the key outside itself.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('order_1');
  });

  it('reports a replayed response', async () => {
    stub.script({
      status: 201,
      headers: { 'Idempotent-Replay': 'true' },
      body: { transaction: {}, payment: null },
    });

    const response = await client().request({
      method: 'POST',
      path: '/partner/v1/transactions',
      body: {},
      idempotencyKey: 'order_1',
    });

    expect(response.replayed).toBe(true);
  });

  it('does not claim a replay when the header is absent', async () => {
    stub.script({ status: 201, body: { transaction: {}, payment: null } });

    const response = await client().request({
      method: 'POST',
      path: '/partner/v1/transactions',
      body: {},
      idempotencyKey: 'order_1',
    });

    expect(response.replayed).toBe(false);
  });
});

describe('request encoding', () => {
  it('omits properties whose value is undefined', async () => {
    stub.script({ status: 200, body: {} });

    await client().request({
      method: 'POST',
      path: '/partner/v1/transactions',
      body: { title: 'thing', delivery_address: undefined },
    });

    const sent = JSON.parse(stub.requests[0]!.body) as Record<string, unknown>;
    // The API rejects an unrecognised property rather than ignoring it, and it
    // distinguishes absent from null. `undefined` must mean absent.
    expect(sent).toEqual({ title: 'thing' });
    expect('delivery_address' in sent).toBe(false);
  });

  it('drops undefined query parameters instead of sending "undefined"', async () => {
    stub.script({ status: 200, body: { object: 'list', data: [], has_more: false } });

    await client().request({
      method: 'GET',
      path: '/partner/v1/transactions',
      query: { limit: 25, status: undefined },
    });

    expect(stub.requests[0]!.url).toBe('/partner/v1/transactions?limit=25');
  });
});

describe('responses that are not the API', () => {
  it('turns a gateway HTML page into a usable ApiError', async () => {
    stub.then({
      status: 502,
      headers: { 'Content-Type': 'text/html' },
      body: '<html><head><title>502 Bad Gateway</title></head></html>',
    });

    const err = await client({ maxRetries: 0 })
      .me()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    // Not a SyntaxError from JSON.parse, which is what an SDK that assumes an
    // error envelope produces - and which tells the merchant nothing.
    expect((err as ApiError).message).toContain('502');
    expect((err as ApiError).status).toBe(502);
  });

  it('reports a refused connection rather than hanging', async () => {
    await stub.stop();

    const err = await client({ maxRetries: 0 })
      .me()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectionError);
  });
});
