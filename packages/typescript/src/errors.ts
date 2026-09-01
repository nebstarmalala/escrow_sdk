import type { ErrorCode } from './types/index.js';

/**
 * Fields every API error carries.
 */
export interface EscrowErrorFields {
  /** Stable and machine-readable. Switch on this, never on `message`. */
  code: ErrorCode | string;
  message: string;
  /** HTTP status, or `0` when the request never got a response. */
  status: number;
  details?: Record<string, unknown> | undefined;
  /** The API's request id, when it sent one. Quote it in a support ticket. */
  requestId?: string | undefined;
}

/**
 * Base class for everything this SDK throws.
 *
 * `catch (e) { if (e instanceof EscrowError) ... }` is the coarse handler; the
 * subclasses below are the ones worth branching on.
 */
export class EscrowError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(fields: EscrowErrorFields) {
    super(fields.message);
    this.name = new.target.name;
    this.code = fields.code;
    this.status = fields.status;
    this.details = fields.details;
    this.requestId = fields.requestId;

    // Without this, `instanceof` breaks for anyone compiling to ES5 - which
    // includes more merchant build setups than you would hope.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 422. The request was understood and refused. Do not retry it unchanged. */
export class ValidationError extends EscrowError {}

/**
 * 401. Missing, malformed, unknown, expired, or wrong-mode key.
 *
 * The API returns an identical body for all of those on purpose, so that the
 * response cannot be used to probe for valid keys. Nothing here can tell you
 * which it was.
 */
export class AuthenticationError extends EscrowError {}

/**
 * 403. Either the partner account is suspended, or the key lacks the scope the
 * route requires (`INSUFFICIENT_SCOPE`). The second is fixed by issuing a key
 * with more scopes; the first is not fixed by anything you can do in code.
 */
export class PermissionError extends EscrowError {}

/**
 * 404. No such object *for this key*.
 *
 * Also what you get for an object belonging to another partner or the other
 * mode — a live key asking about a test transaction included. It is deliberately
 * not a 403, so the response cannot confirm that an id exists.
 */
export class NotFoundError extends EscrowError {}

/**
 * 409. `CONFLICT`, `IDEMPOTENCY_CONFLICT`, or `INVALID_STATE_TRANSITION`.
 *
 * The SDK never retries these automatically. `IDEMPOTENCY_CONFLICT` means the
 * key is bound to a different request and repeating it can only fail again;
 * plain `CONFLICT` may be safe to repeat after a wait, but it also covers a
 * duplicate `partner_reference`, and auto-retrying would quietly paper over a
 * duplicate-order bug.
 */
export class ConflictError extends EscrowError {}

/** 429. `retryAfterSeconds` is the API's own instruction; prefer it to guessing. */
export class RateLimitError extends EscrowError {
  readonly retryAfterSeconds: number | undefined;

  constructor(fields: EscrowErrorFields & { retryAfterSeconds?: number | undefined }) {
    super(fields);
    this.retryAfterSeconds = fields.retryAfterSeconds;
  }
}

/** 422 `INSUFFICIENT_FUNDS`. */
export class InsufficientFundsError extends EscrowError {}

/**
 * 5xx, an unparseable body, or anything else unrecognised.
 *
 * A 502 from a proxy has no error envelope at all, and an SDK that assumes one
 * throws a JSON parse error that tells the merchant nothing.
 */
export class ApiError extends EscrowError {}

/**
 * The request never completed: DNS failure, connection reset, timeout.
 *
 * `status` is 0 because there was no response. Safe to retry, and the SDK does.
 */
export class ConnectionError extends EscrowError {
  constructor(message: string, cause?: unknown) {
    super({ code: 'CONNECTION_ERROR', message, status: 0 });
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Every code the API can return, mapped to the class it becomes.
 *
 * Deliberately exhaustive rather than a `switch` with a `default`: a new code
 * added to the API should surface as an untested mapping here, not silently
 * become a generic error in every merchant's `catch` block.
 */
const CODE_TO_CLASS: Record<string, new (fields: EscrowErrorFields) => EscrowError> = {
  VALIDATION_ERROR: ValidationError,
  UNPROCESSABLE: ValidationError,
  UNAUTHORIZED: AuthenticationError,
  FORBIDDEN: PermissionError,
  INSUFFICIENT_SCOPE: PermissionError,
  NOT_FOUND: NotFoundError,
  CONFLICT: ConflictError,
  IDEMPOTENCY_CONFLICT: ConflictError,
  INVALID_STATE_TRANSITION: ConflictError,
  RATE_LIMITED: RateLimitError,
  INSUFFICIENT_FUNDS: InsufficientFundsError,
  SERVICE_UNAVAILABLE: ApiError,
  INTERNAL: ApiError,
};

/**
 * Builds the right error from a response.
 *
 * `rawBody` is passed as text rather than parsed JSON because a gateway
 * answering instead of the API sends HTML, and that case has to produce a
 * usable error rather than a parse failure.
 */
export function errorFromResponse(
  status: number,
  rawBody: string,
  headers: Headers,
): EscrowError {
  const requestId = headers.get('x-request-id') ?? undefined;

  let code: string | undefined;
  let message: string | undefined;
  let details: Record<string, unknown> | undefined;

  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    code = parsed.error?.code;
    message = parsed.error?.message;
    details = parsed.error?.details;
  } catch {
    // Not an error envelope. Handled below.
  }

  if (code === undefined || message === undefined) {
    return new ApiError({
      code: code ?? 'INTERNAL',
      // The body can be a whole HTML page; a truncated fragment is enough to
      // recognise a proxy without flooding a log line.
      message:
        message ??
        `unexpected response from the API (HTTP ${status})${
          rawBody.trim() === '' ? '' : `: ${rawBody.slice(0, 200)}`
        }`,
      status,
      requestId,
    });
  }

  const fields: EscrowErrorFields = { code, message, status, details, requestId };

  if (code === 'RATE_LIMITED') {
    const header = headers.get('retry-after');
    const seconds = header === null ? undefined : Number.parseInt(header, 10);
    return new RateLimitError({
      ...fields,
      retryAfterSeconds: seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined,
    });
  }

  const Ctor = CODE_TO_CLASS[code];
  return Ctor === undefined ? new ApiError(fields) : new Ctor(fields);
}

/**
 * Whether the SDK's own retry loop may repeat a request.
 *
 * Narrow on purpose. Only 429, 5xx and transport failures qualify; every 409 is
 * handed back to the caller. See `shared/fixtures/errors.json`, which pins this
 * decision for both SDKs.
 */
export function isRetryable(err: EscrowError): boolean {
  if (err instanceof ConnectionError) return true;
  if (err instanceof RateLimitError) return true;
  return err.status >= 500;
}
