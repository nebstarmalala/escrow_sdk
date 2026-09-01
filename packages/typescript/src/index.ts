/**
 * Escrow Partner API client.
 *
 * Server-side only. A secret key must never reach a browser: it can move a
 * merchant's money, and there is no origin check that makes shipping one to a
 * front-end safe.
 */
export const VERSION = '1.0.0';

/** The API version this package speaks. */
export const API_VERSION = '1.0.0';

export { Escrow, DEFAULT_BASE_URL } from './client.js';
export type { EscrowOptions } from './client.js';

export {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  EscrowError,
  InsufficientFundsError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ValidationError,
  isRetryable,
} from './errors.js';
export type { EscrowErrorFields } from './errors.js';

export { ListResult } from './pagination.js';
export type { ListParams, Page } from './pagination.js';

export type { ApiResponse, RateLimitInfo, RequestSpec } from './http.js';

export type * from './types/index.js';
