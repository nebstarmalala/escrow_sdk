import { HttpClient, type ApiResponse, type RequestSpec } from './http.js';
import type { Me } from './types/index.js';

export const DEFAULT_BASE_URL = 'https://api.escrow.co.ke';

export interface EscrowOptions {
  /** A partner secret key: `sk_live_…` or `sk_test_…`. */
  apiKey: string;
  /** Defaults to production. Point this at `http://localhost:8080` for local work. */
  baseUrl?: string;
  /** Per-attempt, in milliseconds. Default 30s. */
  timeoutMs?: number;
  /**
   * Retries *after* the first attempt. Default 2, so three attempts in total.
   * Only 429, 5xx and transport failures are retried; see `errors.ts`.
   */
  maxRetries?: number;
}

const LIVE_PREFIX = 'sk_live_';
const TEST_PREFIX = 'sk_test_';

/**
 * The Escrow Partner API client.
 *
 * Server-side only. A secret key can move a merchant's money, and there is no
 * origin check that makes shipping one to a browser safe.
 */
export class Escrow {
  /**
   * Whether this key moves real money, read from the key itself with no network
   * call.
   *
   * Available before the first request on purpose. Discovering at checkout time
   * that you deployed a test key — or worse, a live one — is too late, and a
   * boot-time assertion is the cheapest guard there is:
   *
   * ```ts
   * if (!escrow.livemode && process.env.NODE_ENV === 'production') {
   *   throw new Error('refusing to start with a test key in production');
   * }
   * ```
   */
  readonly livemode: boolean;

  readonly baseUrl: string;

  private readonly http: HttpClient;

  constructor(options: EscrowOptions) {
    const apiKey = options.apiKey?.trim();

    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'an API key is required. Pass one as `new Escrow({ apiKey })`, from a secret ' +
          'store or an environment variable - never a literal in source.',
      );
    }

    if (apiKey.startsWith(LIVE_PREFIX)) {
      this.livemode = true;
    } else if (apiKey.startsWith(TEST_PREFIX)) {
      this.livemode = false;
    } else {
      // Fail here rather than on the first 401. A key that is a truncated copy,
      // a webhook secret, or an admin token is a configuration mistake, and the
      // API deliberately returns an identical 401 for every one of those - so
      // the server can never tell you which it was.
      throw new Error(
        `that does not look like a partner API key: it should begin with "${LIVE_PREFIX}" ` +
          `or "${TEST_PREFIX}". A webhook signing secret (whsec_…) is a different thing ` +
          'and cannot be used here.',
      );
    }

    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

    this.http = new HttpClient({
      apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      userAgent: userAgent(),
    });
  }

  /** Confirms the key works, and reports its partner, scopes and quota. */
  async me(): Promise<Me> {
    const response = await this.http.request<Me>({ method: 'GET', path: '/partner/v1/me' });
    return response.data;
  }

  /**
   * Escape hatch for an endpoint this SDK does not wrap yet, and the only way
   * to see the full response envelope — status, request id, rate-limit headers,
   * and whether the API replayed a stored response.
   */
  async request<T>(spec: RequestSpec): Promise<ApiResponse<T>> {
    return this.http.request<T>(spec);
  }

  /** @internal — resources use this; it is not part of the supported surface. */
  get transport(): HttpClient {
    return this.http;
  }
}

function userAgent(): string {
  const version =
    (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
  return version === undefined
    ? 'escrow-sdk-node/1.0.0'
    : `escrow-sdk-node/1.0.0 node/${version}`;
}
