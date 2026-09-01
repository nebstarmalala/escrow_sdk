<?php

declare(strict_types=1);

namespace Aminitrust\Escrow;

/**
 * GENERATED FROM shared/partner-openapi.yaml - DO NOT EDIT BY HAND.
 *
 * Regenerate with:  node scripts/generate-types.mjs
 *
 * These are PHPStan shapes, not classes. The API surface is arrays, which is
 * what json_decode produces and what a PHP integrator expects; the shapes are
 * what make those arrays checkable at level 8, so a mistyped key is a static
 * error rather than a null at runtime.
 *
 * Spec version 1.0.0.
 *
 * @phpstan-type Error array{
 *     error: array{
 *       code: 'VALIDATION_ERROR'|'UNAUTHORIZED'|'FORBIDDEN'|'INSUFFICIENT_SCOPE'|'NOT_FOUND'|'CONFLICT'|'IDEMPOTENCY_CONFLICT'|'RATE_LIMITED'|'UNPROCESSABLE'|'INVALID_STATE_TRANSITION'|'INSUFFICIENT_FUNDS'|'SERVICE_UNAVAILABLE'|'INTERNAL',
 *       message: string,
 *       details?: array<string, mixed>,
 *     },
 *   }
 *
 * @phpstan-type Me array{
 *     object: 'partner',
 *     partner_id: string,
 *     key_prefix: string,
 *     livemode: bool,
 *     scopes: list<'transactions:read'|'transactions:write'|'disputes:read'|'webhooks:manage'|'events:read'>,
 *     rate_limit_per_min: int,
 *     time: string,
 *   }
 *
 * @phpstan-type TransactionStatus 'draft'|'pending_acceptance'|'accepted'|'funded'|'item_sent'|'inspection'|'released'|'completed'|'disputed'|'refunded'|'split'|'cancelled'|'expired'
 *
 * @phpstan-type Buyer array{
 *     full_name?: string,
 *     masked_email?: string,
 *     masked_phone?: string,
 *   }
 *
 * @phpstan-type Transaction array{
 *     id: string,
 *     object: 'transaction',
 *     partner_reference?: string|null,
 *     reference: string,
 *     status: TransactionStatus,
 *     amount_minor: int,
 *     fee_minor: int,
 *     payable_minor: int,
 *     currency: 'KES',
 *     fee_payer?: 'buyer'|'seller'|'split',
 *     title?: string,
 *     description?: string,
 *     item_type?: string,
 *     category?: string,
 *     buyer?: Buyer,
 *     delivery_method?: string,
 *     delivery_timeline?: string,
 *     delivery_address?: string|null,
 *     inspection_period_hours?: float,
 *     inspection_started_at?: string|null,
 *     release_after?: string|null,
 *     funded_at?: string|null,
 *     released_at?: string|null,
 *     cancel_reason?: string|null,
 *     livemode: bool,
 *     metadata?: array<string, mixed>,
 *     created_at: string,
 *     updated_at: string,
 *   }
 *
 * @phpstan-type CreateWebhookEndpointRequest array{
 *     url: string,
 *     description?: string,
 *     event_types?: list<WebhookEventType>,
 *   }
 *
 * @phpstan-type UpdateWebhookEndpointRequest array{
 *     url?: string,
 *     description?: string,
 *     event_types?: list<WebhookEventType>,
 *   }
 *
 * @phpstan-type WebhookEventType 'transaction.created'|'transaction.accepted'|'transaction.funded'|'transaction.shipped'|'transaction.inspection_started'|'transaction.released'|'transaction.completed'|'transaction.refunded'|'transaction.cancelled'|'transaction.expired'|'dispute.opened'|'dispute.resolved'|'payment.succeeded'|'payment.failed'
 *
 * @phpstan-type WebhookEndpoint array{
 *     id: string,
 *     object: 'webhook_endpoint',
 *     url: string,
 *     description?: string,
 *     status: 'ENABLED'|'DISABLED',
 *     livemode: bool,
 *     event_types: list<WebhookEventType>,
 *     created_at: string,
 *     updated_at: string,
 *     disabled_at?: string|null,
 *   }
 *
 * @phpstan-type WebhookEndpointWithSecret array{
 *     id: string,
 *     object: 'webhook_endpoint',
 *     url: string,
 *     description?: string,
 *     status: 'ENABLED'|'DISABLED',
 *     livemode: bool,
 *     event_types: list<WebhookEventType>,
 *     created_at: string,
 *     updated_at: string,
 *     disabled_at?: string|null,
 *     signing_secret: string,
 *     previous_secret_expires_at?: string,
 *   }
 *
 * @phpstan-type WebhookEvent array{
 *     id: string,
 *     object: 'event',
 *     type: WebhookEventType,
 *     created: int,
 *     livemode: bool,
 *     sequence?: int,
 *     data: array{
 *       object: array<string, mixed>,
 *     },
 *   }
 *
 * @phpstan-type WebhookEndpointList array{
 *     object: 'list',
 *     data: list<WebhookEndpoint>,
 *   }
 *
 * @phpstan-type WebhookDelivery array{
 *     id: string,
 *     object: 'webhook_delivery',
 *     endpoint_id: string,
 *     event_id: string,
 *     event_type: WebhookEventType,
 *     status: 'PENDING'|'DELIVERED'|'FAILED',
 *     attempt_count: int,
 *     next_attempt_at?: string|null,
 *     last_status_code?: int|null,
 *     last_error?: string|null,
 *     livemode: bool,
 *     payload?: array<string, mixed>,
 *     created_at: string,
 *     delivered_at?: string|null,
 *   }
 *
 * @phpstan-type WebhookDeliveryList array{
 *     object: 'list',
 *     has_more: bool,
 *     next_cursor?: string|null,
 *     data: list<WebhookDelivery>,
 *   }
 *
 * @phpstan-type CreateTransactionRequest array{
 *     partner_reference?: string,
 *     amount_minor: int,
 *     currency?: 'KES',
 *     title: string,
 *     description: string,
 *     item_type: string,
 *     category: string,
 *     buyer: array{
 *       email?: string,
 *       phone?: string,
 *       full_name?: string,
 *     },
 *     delivery_method: string,
 *     delivery_timeline: string,
 *     delivery_address?: string|null,
 *     agreed_terms?: string,
 *     inspection_period_hours?: float,
 *     fee_payer?: 'BUYER'|'SELLER'|'SPLIT',
 *     payment?: array{
 *       method: 'mpesa'|'card'|'bank',
 *       phone?: string,
 *     },
 *     metadata?: array<string, mixed>,
 *   }
 *
 * @phpstan-type PaymentRequest array{
 *     method: 'mpesa'|'card'|'bank',
 *     phone?: string,
 *   }
 *
 * @phpstan-type RefundRequest array{
 *     reason?: string,
 *   }
 *
 * @phpstan-type Payment array{
 *     object?: 'payment',
 *     status?: string,
 *     reference?: string,
 *     amount_minor?: int,
 *     method?: string,
 *     checkout_url?: string,
 *     failure_reason?: string|null,
 *   }
 *
 * @phpstan-type CreateTransactionResponse array{
 *     transaction: Transaction,
 *     payment?: array{
 *       object?: 'payment',
 *       status?: string,
 *       reference?: string,
 *       amount_minor?: int,
 *       method?: string,
 *       checkout_url?: string,
 *       failure_reason?: string|null,
 *     },
 *   }
 *
 * @phpstan-type Dispute array{
 *     id: string,
 *     object: 'dispute',
 *     transaction_id: string,
 *     transaction_reference?: string,
 *     status: string,
 *     reason?: string,
 *     title?: string,
 *     description?: string,
 *     amount_minor?: int,
 *     currency?: string,
 *     resolution_type?: string|null,
 *     resolved_at?: string|null,
 *     created_at: string,
 *     updated_at: string,
 *   }
 *
 * @phpstan-type ListEnvelope array{
 *     object: 'list',
 *     has_more: bool,
 *     next_cursor?: string|null,
 *   }
 *
 * @phpstan-type TransactionList array{
 *     object: 'list',
 *     has_more: bool,
 *     next_cursor?: string|null,
 *     data: list<Transaction>,
 *   }
 *
 * @phpstan-type DisputeList array{
 *     object: 'list',
 *     has_more: bool,
 *     next_cursor?: string|null,
 *     data: list<Dispute>,
 *   }
 */
final class Types
{
    /** The API version these shapes were generated from. */
    public const API_VERSION = '1.0.0';

    public const EVENT_TYPES = [
        'transaction.created',
        'transaction.accepted',
        'transaction.funded',
        'transaction.shipped',
        'transaction.inspection_started',
        'transaction.released',
        'transaction.completed',
        'transaction.refunded',
        'transaction.cancelled',
        'transaction.expired',
        'dispute.opened',
        'dispute.resolved',
        'payment.succeeded',
        'payment.failed',
    ];

    public const ERROR_CODES = [
        'VALIDATION_ERROR',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'INSUFFICIENT_SCOPE',
        'NOT_FOUND',
        'CONFLICT',
        'IDEMPOTENCY_CONFLICT',
        'RATE_LIMITED',
        'UNPROCESSABLE',
        'INVALID_STATE_TRANSITION',
        'INSUFFICIENT_FUNDS',
        'SERVICE_UNAVAILABLE',
        'INTERNAL',
    ];

    public const TRANSACTION_STATUSES = [
        'draft',
        'pending_acceptance',
        'accepted',
        'funded',
        'item_sent',
        'inspection',
        'released',
        'completed',
        'disputed',
        'refunded',
        'split',
        'cancelled',
        'expired',
    ];

    private function __construct()
    {
    }
}
