import type { HttpClient } from '../http.js';
import { randomIdempotencyKey } from '../http.js';
import { ListResult, type ListParams } from '../pagination.js';
import type {
  CreateWebhookEndpointParams,
  UpdateWebhookEndpointParams,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from '../types/index.js';

export class WebhookEndpoints {
  constructor(private readonly http: HttpClient) {}

  /**
   * Registers an endpoint.
   *
   * The response is the **only** time the signing secret is returned. Store it
   * before you do anything else with the value; there is no endpoint that will
   * show it to you again, only one that replaces it.
   *
   * The URL must be `https` and must not resolve to a private address. That is
   * checked here and again at delivery time, because a DNS name that passes
   * registration can be repointed afterwards.
   */
  async create(
    params: CreateWebhookEndpointParams,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<WebhookEndpointWithSecret> {
    const response = await this.http.request<WebhookEndpointWithSecret>({
      method: 'POST',
      path: '/partner/v1/webhook_endpoints',
      body: params,
      idempotencyKey: options.idempotencyKey ?? randomIdempotencyKey(),
      signal: options.signal,
    });
    return response.data;
  }

  async retrieve(id: string): Promise<WebhookEndpoint> {
    const response = await this.http.request<WebhookEndpoint>({
      method: 'GET',
      path: `/partner/v1/webhook_endpoints/${encodeURIComponent(id)}`,
    });
    return response.data;
  }

  list(params: ListParams = {}): ListResult<WebhookEndpoint> {
    return new ListResult<WebhookEndpoint>(this.http, '/partner/v1/webhook_endpoints', {
      limit: params.limit,
      starting_after: params.starting_after,
    });
  }

  async update(id: string, params: UpdateWebhookEndpointParams): Promise<WebhookEndpoint> {
    const response = await this.http.request<WebhookEndpoint>({
      method: 'PATCH',
      path: `/partner/v1/webhook_endpoints/${encodeURIComponent(id)}`,
      body: params,
    });
    return response.data;
  }

  /** Permanent. Deliveries already queued for it stop. */
  async del(id: string): Promise<void> {
    await this.http.request<void>({
      method: 'DELETE',
      path: `/partner/v1/webhook_endpoints/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Issues a new signing secret and returns it once.
   *
   * The previous secret keeps working for a grace window, during which every
   * delivery carries two `v1` signatures — one per secret. That is what makes a
   * rotation deployable: verify with either, deploy the new one, and no
   * delivery is dropped in between.
   */
  async rotateSecret(id: string): Promise<WebhookEndpointWithSecret> {
    const response = await this.http.request<WebhookEndpointWithSecret>({
      method: 'POST',
      path: `/partner/v1/webhook_endpoints/${encodeURIComponent(id)}/rotate_secret`,
      idempotencyKey: randomIdempotencyKey(),
    });
    return response.data;
  }
}

export interface ListDeliveryParams extends ListParams {
  endpoint_id?: string;
  status?: 'PENDING' | 'DELIVERED' | 'FAILED';
}

/**
 * The delivery log — what was sent, what came back, and what is still being
 * retried.
 *
 * Worth reaching for when an endpoint was down: the API retries over about 22
 * hours on its own, but this is how you see what happened and force a specific
 * one through afterwards.
 */
export class WebhookDeliveries {
  constructor(private readonly http: HttpClient) {}

  async retrieve(id: string): Promise<WebhookDelivery> {
    const response = await this.http.request<WebhookDelivery>({
      method: 'GET',
      path: `/partner/v1/webhook_deliveries/${encodeURIComponent(id)}`,
    });
    return response.data;
  }

  list(params: ListDeliveryParams = {}): ListResult<WebhookDelivery> {
    return new ListResult<WebhookDelivery>(this.http, '/partner/v1/webhook_deliveries', {
      limit: params.limit,
      starting_after: params.starting_after,
      endpoint_id: params.endpoint_id,
      status: params.status,
    });
  }

  /**
   * Sends one delivery again.
   *
   * It arrives with the same event `id` as the original, so a receiver that
   * deduplicates on it — which the API asks you to do — will correctly treat a
   * retry of something already processed as a no-op.
   */
  async retry(id: string): Promise<WebhookDelivery> {
    const response = await this.http.request<WebhookDelivery>({
      method: 'POST',
      path: `/partner/v1/webhook_deliveries/${encodeURIComponent(id)}/retry`,
      idempotencyKey: randomIdempotencyKey(),
    });
    return response.data;
  }
}
