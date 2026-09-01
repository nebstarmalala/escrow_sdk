import type { HttpClient } from '../http.js';
import { ListResult, type ListParams } from '../pagination.js';
import type { Dispute } from '../types/index.js';

export interface ListDisputeParams extends ListParams {
  status?: string;
}

/**
 * Read-only, and deliberately so.
 *
 * There is no endpoint for a merchant to open a dispute. A dispute is the
 * shopper's instrument; one raised "on behalf of" them by the party holding the
 * goods is a fraud vector, not a convenience.
 */
export class Disputes {
  constructor(private readonly http: HttpClient) {}

  async retrieve(id: string, options: { signal?: AbortSignal } = {}): Promise<Dispute> {
    const response = await this.http.request<Dispute>({
      method: 'GET',
      path: `/partner/v1/disputes/${encodeURIComponent(id)}`,
      signal: options.signal,
    });
    return response.data;
  }

  list(params: ListDisputeParams = {}): ListResult<Dispute> {
    return new ListResult<Dispute>(this.http, '/partner/v1/disputes', {
      limit: params.limit,
      starting_after: params.starting_after,
      status: params.status,
    });
  }
}
