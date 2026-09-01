import { EscrowError } from './errors.js';
import type { WebhookEvent } from './types/index.js';

/** Thrown when a delivery cannot be trusted. Never catch this and continue. */
export class WebhookSignatureError extends EscrowError {
  constructor(message: string) {
    super({ code: 'WEBHOOK_SIGNATURE_INVALID', message, status: 0 });
  }
}

export interface VerifyOptions {
  /**
   * How far the delivery's timestamp may be from now, in either direction.
   * Default 300s.
   *
   * Both directions matter. A clock far ahead is as suspect as one far behind,
   * and checking only for staleness is the usual half-implementation.
   */
  toleranceSeconds?: number;
  /** Override the clock. For tests. */
  now?: Date;
}

const DEFAULT_TOLERANCE_SECONDS = 300;
const encoder = new TextEncoder();

/**
 * Verifies a delivery and returns the parsed event.
 *
 * **`rawBody` must be the exact bytes the API sent.** Not a parsed object, not
 * an object re-serialised with `JSON.stringify`: round-tripping through JSON
 * changes key order and whitespace, the MAC stops matching, and the resulting
 * error looks like a wrong secret rather than a body-handling mistake. This is
 * the single most common integration bug against this API.
 *
 * ```ts
 * // Express: express.raw({ type: 'application/json' }) on this route only
 * app.post('/webhooks/escrow', express.raw({ type: 'application/json' }), async (req, res) => {
 *   const event = await escrow.webhooks.verify(req.body, req.get('Escrow-Signature'), secret);
 *   res.sendStatus(200);         // acknowledge first
 *   await enqueue(event);        // then do the work
 * });
 * ```
 *
 * Throws rather than returning a boolean, deliberately: a merchant who forgets
 * to check a returned flag has no verification at all, and that failure is
 * silent.
 */
export async function verify(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  if (signatureHeader === null || signatureHeader === undefined || signatureHeader === '') {
    throw new WebhookSignatureError(
      'no Escrow-Signature header. Check your framework is not stripping unknown headers, ' +
        'and that this route is not behind a proxy that drops them.',
    );
  }

  if (secret === '' || !secret.startsWith('whsec_')) {
    throw new WebhookSignatureError(
      'the signing secret should begin with "whsec_". An API key (sk_live_… / sk_test_…) ' +
        'is a different thing and will never verify.',
    );
  }

  const { timestamp, signatures } = parseHeader(signatureHeader);

  if (timestamp === undefined) {
    throw new WebhookSignatureError(`no timestamp in the signature header: "${signatureHeader}"`);
  }
  if (signatures.length === 0) {
    throw new WebhookSignatureError(`no v1 signature in the header: "${signatureHeader}"`);
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const age = now - timestamp;

  if (age > tolerance || age < -tolerance) {
    throw new WebhookSignatureError(
      `the delivery's timestamp is ${age}s away from now, outside the ${tolerance}s tolerance. ` +
        'This is either a replayed request or a clock that needs fixing.',
    );
  }

  const body = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
  const expected = await computeSignature(secret, String(timestamp), body);

  // Any signature may match: during a rotation the API sends one per active
  // secret, so a receiver holding either the new or the old one still verifies.
  let matched = false;
  for (const candidate of signatures) {
    if (timingSafeEqual(candidate, expected)) matched = true;
  }

  if (!matched) {
    throw new WebhookSignatureError(
      'the signature does not match. The usual cause is a re-serialised body: verification ' +
        'needs the raw bytes, before any JSON parsing.',
    );
  }

  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  try {
    return JSON.parse(text) as WebhookEvent;
  } catch {
    throw new WebhookSignatureError('the body verified but is not valid JSON');
  }
}

/**
 * Builds a signature header. For testing your own handler.
 *
 * Nothing in a merchant's production path signs anything — this exists so a
 * webhook route can be exercised in a test suite without a live delivery.
 */
export async function signPayload(
  secrets: string[],
  timestamp: Date,
  body: string | Uint8Array,
): Promise<string> {
  const ts = String(Math.floor(timestamp.getTime() / 1000));
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;

  const parts = [`t=${ts}`];
  for (const secret of secrets) {
    if (secret === '') continue;
    parts.push(`v1=${await computeSignature(secret, ts, bytes)}`);
  }
  return parts.join(',');
}

function parseHeader(header: string): { timestamp: number | undefined; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const rawPart of header.split(',')) {
    // Trimmed because proxies reformat header values, and a leading space
    // would otherwise turn "v1=…" into an unrecognised part.
    const part = rawPart.trim();

    if (part.startsWith('t=')) {
      const parsed = Number.parseInt(part.slice(2), 10);
      if (Number.isFinite(parsed) && String(parsed) === part.slice(2)) {
        timestamp = parsed;
      }
    } else if (part.startsWith('v1=')) {
      signatures.push(part.slice(3));
    }
  }

  return { timestamp, signatures };
}

async function computeSignature(secret: string, ts: string, body: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      'Web Crypto is not available in this runtime, so webhook signatures cannot be verified. ' +
        'Node 18 or newer is required.',
    );
  }

  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  // "<timestamp>.<body>", never the body alone. With the timestamp inside the
  // MAC, a captured delivery cannot be replayed onto a fresh timestamp - which
  // is what makes the tolerance check above worth anything.
  const signed = new Uint8Array(body.length + ts.length + 1);
  signed.set(encoder.encode(`${ts}.`), 0);
  signed.set(body, ts.length + 1);

  const mac = await subtle.sign('HMAC', key, signed);
  return Array.from(new Uint8Array(mac), (b: number) => b.toString(16).padStart(2, '0')).join('');
}

interface SubtleCryptoLike {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: boolean,
    usages: ['sign'],
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

/**
 * Compares two hex digests without an early exit.
 *
 * Both are fixed-length hex, so the length check leaks nothing an attacker does
 * not already know. Perfect constant time is not achievable in a JIT-compiled
 * language, but an early-returning comparison leaks the expected MAC one
 * character at a time to anyone able to submit guesses, and this does not.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The webhook helpers, reachable as `escrow.webhooks`. */
export const webhooks = { verify, signPayload };
