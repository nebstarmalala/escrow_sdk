import type { HttpClient } from '../http.js';
import { randomIdempotencyKey } from '../http.js';
import { ListResult, type ListParams } from '../pagination.js';
import type {
  CreateTransactionParams,
  CreateTransactionResult,
  PaymentParams,
  RefundParams,
  Transaction,
  TransactionStatus,
} from '../types/index.js';

export interface WriteOptions {
  /**
   * A unique value per *logical* request, reused on every retry of it. Your own
   * order id is usually the right choice: it is unique by construction, and it
   * makes a replay visible in your own logs.
   *
   * Omit it and one is generated — which is safe for this call, but not across
   * a process restart. If the request times out and your job runs again, a
   * generated key is a different key, and a different key is a second escrow.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ListTransactionParams extends ListParams {
  status?: TransactionStatus;
}

/**
 * Result of a create, with whether the API replayed a stored response.
 *
 * `replayed` is a client-side annotation, not a field the API sends. It is here
 * because "did this actually execute?" is the question a merchant needs
 * answered after a retry, and the alternative is reading a header by hand.
 */
export type CreateResult = CreateTransactionResult & { replayed: boolean };

/**
 * A refund wraps the transaction rather than carrying `replayed` among its own
 * fields.
 *
 * A stray boolean sitting inside a transaction object is the kind of thing that
 * ends up serialised into a merchant's database by accident. The PHP SDK
 * returns the same shape, so one document describes both.
 */
export interface RefundResult {
  transaction: Transaction;
  replayed: boolean;
}

export class Transactions {
  constructor(private readonly http: HttpClient) {}

  /**
   * Creates an escrow for an order, and optionally charges the shopper.
   *
   * Two outcomes, and both must be handled:
   *
   * - The shopper is new to escrow, so the transaction is auto-accepted on your
   *   attestation and `payment` describes the charge.
   * - The shopper already has an escrow account, so the transaction stays
   *   `pending_acceptance`, `payment` is `null`, and **nothing has been
   *   charged**. They accept in their own app. This is not an error and does
   *   not throw; an integration that ignores it has orders that silently never
   *   fund.
   *
   * Record the returned id against your order *before* you rely on it. If this
   * call times out, the escrow may well exist.
   */
  async create(params: CreateTransactionParams, options: WriteOptions = {}): Promise<CreateResult> {
    const response = await this.http.request<CreateTransactionResult>({
      method: 'POST',
      path: '/partner/v1/transactions',
      body: params,
      idempotencyKey: options.idempotencyKey ?? randomIdempotencyKey(),
      requiresIdempotencyKey: true,
      signal: options.signal,
    });
    return { ...response.data, replayed: response.replayed };
  }

  async retrieve(id: string, options: { signal?: AbortSignal } = {}): Promise<Transaction> {
    const response = await this.http.request<Transaction>({
      method: 'GET',
      path: `/partner/v1/transactions/${encodeURIComponent(id)}`,
      signal: options.signal,
    });
    return response.data;
  }

  /** Newest first, scoped to this key's partner and mode. Iterate it directly. */
  list(params: ListTransactionParams = {}): ListResult<Transaction> {
    return new ListResult<Transaction>(this.http, '/partner/v1/transactions', {
      limit: params.limit,
      starting_after: params.starting_after,
      status: params.status,
    });
  }

  /**
   * Marks the item shipped, which starts the shopper's inspection window.
   *
   * Only valid from `funded`. Calling it earlier is a `409`, not a no-op.
   */
  async ship(id: string, options: WriteOptions = {}): Promise<Transaction> {
    return this.action(id, 'ship', undefined, options);
  }

  /**
   * Cancels an escrow that has not been funded.
   *
   * Once money is held this is a `409` — use {@link refund}. Cancelling a
   * funded escrow would leave the shopper's money with nowhere to go, which is
   * why the API refuses rather than guessing.
   */
  async cancel(id: string, options: WriteOptions = {}): Promise<Transaction> {
    return this.action(id, 'cancel', undefined, options);
  }

  /**
   * Starts or retries the charge on an `accepted` transaction.
   *
   * This is the call for a create that came back with `payment.status:
   * "failed"`. Creating a second transaction instead is the mistake it exists
   * to prevent: the first escrow is still there, still accepted, and still
   * counted.
   */
  async pay(id: string, params: PaymentParams, options: WriteOptions = {}): Promise<Transaction> {
    return this.action(id, 'payments', params, options);
  }

  /**
   * Returns the escrowed principal to the shopper, in full.
   *
   * The counterpart to there being no release endpoint: you can always give
   * money back, never take it. The funding fee is not returned — it paid for
   * escrow already rendered.
   *
   * A transaction already under dispute cannot be refunded this way; that is
   * the mediator's decision.
   */
  async refund(
    id: string,
    params: RefundParams = {},
    options: WriteOptions = {},
  ): Promise<RefundResult> {
    const response = await this.http.request<Transaction>({
      method: 'POST',
      path: `/partner/v1/transactions/${encodeURIComponent(id)}/refund`,
      body: params,
      idempotencyKey: options.idempotencyKey ?? randomIdempotencyKey(),
      requiresIdempotencyKey: true,
      signal: options.signal,
    });
    return { transaction: response.data, replayed: response.replayed };
  }

  private async action(
    id: string,
    action: string,
    body: unknown,
    options: WriteOptions,
  ): Promise<Transaction> {
    const response = await this.http.request<Transaction>({
      method: 'POST',
      path: `/partner/v1/transactions/${encodeURIComponent(id)}/${action}`,
      body,
      // Optional on these routes rather than required, but always sent: the
      // cost is a header, and the alternative is a retried timeout shipping
      // twice or starting a second STK prompt.
      idempotencyKey: options.idempotencyKey ?? randomIdempotencyKey(),
      signal: options.signal,
    });
    return response.data;
  }
}
