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

export type * from './types/index.js';
