import { describe, expect, it } from 'vitest';

import { DEFAULT_BASE_URL, Escrow } from '../../src/client.js';
import { randomIdempotencyKey } from '../../src/http.js';

const LIVE = 'sk_live_' + 'b'.repeat(43);
const TEST = 'sk_test_' + 'a'.repeat(43);

describe('constructing a client', () => {
  it('reads livemode from the key with no network call', () => {
    expect(new Escrow({ apiKey: LIVE }).livemode).toBe(true);
    expect(new Escrow({ apiKey: TEST }).livemode).toBe(false);
  });

  it('defaults to production', () => {
    expect(new Escrow({ apiKey: TEST }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('normalises a trailing slash on baseUrl', () => {
    // Otherwise every path becomes a double slash, which some proxies redirect
    // and some 404 - and the failure looks like a routing bug in the API.
    expect(new Escrow({ apiKey: TEST, baseUrl: 'http://localhost:8080/' }).baseUrl).toBe(
      'http://localhost:8080',
    );
  });

  it('refuses an empty key', () => {
    expect(() => new Escrow({ apiKey: '' })).toThrow(/API key is required/);
    expect(() => new Escrow({ apiKey: '   ' })).toThrow(/API key is required/);
  });

  it('refuses anything that is not a partner key', () => {
    // The API returns an identical 401 for every kind of bad key, so it can
    // never tell you which mistake you made. Catching the shape here is the
    // only place a useful message is possible.
    expect(() => new Escrow({ apiKey: 'whsec_abc' })).toThrow(/whsec/);
    expect(() => new Escrow({ apiKey: 'sk_prod_abc' })).toThrow(/sk_live_/);
    expect(() => new Escrow({ apiKey: 'Bearer sk_test_abc' })).toThrow(/sk_test_/);
  });

  it('tolerates a key pasted with surrounding whitespace', () => {
    // Copied out of a dashboard or read from a file with a trailing newline.
    expect(new Escrow({ apiKey: `  ${TEST}\n` }).livemode).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('generates distinct v4 UUIDs on this runtime', () => {
    const a = randomIdempotencyKey();
    const b = randomIdempotencyKey();

    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
