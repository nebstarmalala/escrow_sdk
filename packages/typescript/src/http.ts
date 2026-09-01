import {
  ConnectionError,
  type EscrowError,
  errorFromResponse,
  isRetryable,
} from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestSpec {
  method: HttpMethod;
  /** Full path including the version prefix, e.g. `/partner/v1/transactions`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  body?: unknown;
  /**
   * Reused across every retry of this request. That reuse is the entire point:
   * a fresh key per attempt would create a second escrow and fire a second
   * M-Pesa prompt at the shopper.
   */
  idempotencyKey?: string | undefined;
  /** Set for endpoints that move money, where the API requires a key. */
  requiresIdempotencyKey?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  /** True when the API replayed a stored response instead of executing again. */
  replayed: boolean;
  requestId: string | undefined;
  /** Present on 429, and on any response the API chose to annotate. */
  rateLimit: RateLimitInfo | undefined;
}

export interface RateLimitInfo {
  limit: number | undefined;
  remaining: number | undefined;
  resetSeconds: number | undefined;
}

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
}

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8_000;

export class HttpClient {
  constructor(private readonly opts: HttpClientOptions) {}

  async request<T>(spec: RequestSpec): Promise<ApiResponse<T>> {
    if (spec.requiresIdempotencyKey === true && spec.idempotencyKey === undefined) {
      throw new Error(
        'internal: an endpoint that moves money was called without an idempotency key',
      );
    }

    const url = this.buildUrl(spec);
    const init = this.buildInit(spec);

    let lastError: EscrowError | undefined;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt, lastError));
      }

      try {
        return await this.attempt<T>(url, init, spec.signal);
      } catch (err) {
        const escrowError = err as EscrowError;
        // An AbortError from the caller's own signal is a cancellation, not a
        // failure to retry around.
        if (spec.signal?.aborted === true) throw escrowError;
        if (!isRetryable(escrowError)) throw escrowError;
        lastError = escrowError;
      }
    }

    // Every attempt was retryable and every attempt failed.
    throw lastError;
  }

  private buildUrl(spec: RequestSpec): string {
    const url = new URL(this.opts.baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private buildInit(spec: RequestSpec): RequestInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.opts.userAgent,
    };

    if (spec.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = spec.idempotencyKey;
    }

    const init: RequestInit = { method: spec.method, headers };

    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      // JSON.stringify drops properties whose value is `undefined`, which is
      // exactly what is needed: the API rejects an unrecognised property rather
      // than ignoring it, and `{ delivery_address: undefined }` must not become
      // `{"delivery_address":null}`.
      init.body = JSON.stringify(spec.body);
    }

    return init;
  }

  private async attempt<T>(
    url: string,
    init: RequestInit,
    callerSignal: AbortSignal | undefined,
  ): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.opts.timeoutMs);

    const onCallerAbort = (): void => {
      controller.abort();
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (callerSignal?.aborted === true) {
        throw new ConnectionError('the request was cancelled', err);
      }
      throw new ConnectionError(
        controller.signal.aborted
          ? `the request timed out after ${this.opts.timeoutMs}ms`
          : `could not reach the API: ${(err as Error).message}`,
        err,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }

    // Read as text, always. A gateway answering instead of the API sends HTML,
    // and `response.json()` on that throws a SyntaxError that tells the
    // merchant nothing about what actually happened.
    const raw = await response.text();

    if (!response.ok) {
      throw errorFromResponse(response.status, raw, response.headers);
    }

    return {
      data: (raw.trim() === '' ? undefined : JSON.parse(raw)) as T,
      status: response.status,
      replayed: response.headers.get('idempotent-replay') === 'true',
      requestId: response.headers.get('x-request-id') ?? undefined,
      rateLimit: readRateLimit(response.headers),
    };
  }
}

function readRateLimit(headers: Headers): RateLimitInfo | undefined {
  const limit = intOrUndefined(headers.get('ratelimit-limit'));
  const remaining = intOrUndefined(headers.get('ratelimit-remaining'));
  const resetSeconds = intOrUndefined(headers.get('ratelimit-reset'));
  if (limit === undefined && remaining === undefined && resetSeconds === undefined) {
    return undefined;
  }
  return { limit, remaining, resetSeconds };
}

function intOrUndefined(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Full jitter, capped, with the API's own `Retry-After` taking precedence.
 *
 * Full jitter rather than exponential-plus-a-little: when a shared dependency
 * recovers, every client that backed off in lockstep returns in lockstep and
 * knocks it over again.
 */
export function backoffMs(attempt: number, lastError: EscrowError | undefined): number {
  const retryAfter = (lastError as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
  if (retryAfter !== undefined && Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter) * 1000;
  }
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A UUIDv4 for use as an idempotency key.
 *
 * Web Crypto first so the package keeps working on Workers, Deno and Bun, where
 * `node:crypto` does not exist. There is deliberately no `Math.random` fallback:
 * a weak idempotency key silently stops being idempotent, and failing loudly
 * with an instruction is better than charging a shopper twice.
 */
export function randomIdempotencyKey(): string {
  // Typed structurally rather than as `Crypto`. That global interface comes
  // from the DOM lib, which this package does not pull in - it targets servers,
  // and adding DOM would also make `document` and `window` typecheck.
  interface WebCryptoLike {
    randomUUID?: () => string;
    getRandomValues?: (array: Uint8Array) => Uint8Array;
  }
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;

  if (typeof webcrypto?.randomUUID === 'function') {
    return webcrypto.randomUUID();
  }

  if (typeof webcrypto?.getRandomValues === 'function') {
    const bytes = webcrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b: number) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  throw new Error(
    'no cryptographic random source is available, so an idempotency key cannot be generated. ' +
      'Pass one explicitly: escrow.transactions.create(params, { idempotencyKey: order.id })',
  );
}
