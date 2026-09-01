// Clean public names for the generated schema types.
//
// `src/types/generated.ts` is machine-written and must never be hand-edited, so
// its `Schema*` prefixes are not something to fight. This file is the seam: it
// gives integrators `Transaction` rather than `SchemaTransaction`, and it means
// a future generator switch changes one file instead of the whole SDK.
import type {
  SchemaBuyer,
  SchemaCreateTransactionRequest,
  SchemaCreateTransactionResponse,
  SchemaCreateWebhookEndpointRequest,
  SchemaDispute,
  SchemaDisputeList,
  SchemaError,
  SchemaListEnvelope,
  SchemaMe,
  SchemaPayment,
  SchemaPaymentRequest,
  SchemaRefundRequest,
  SchemaTransaction,
  SchemaTransactionList,
  SchemaTransactionStatus,
  SchemaUpdateWebhookEndpointRequest,
  SchemaWebhookDelivery,
  SchemaWebhookDeliveryList,
  SchemaWebhookEndpoint,
  SchemaWebhookEndpointList,
  SchemaWebhookEndpointWithSecret,
  SchemaWebhookEvent,
  SchemaWebhookEventType,
} from './generated.js';

export type Buyer = SchemaBuyer;
export type CreateTransactionParams = SchemaCreateTransactionRequest;
export type CreateTransactionResult = SchemaCreateTransactionResponse;
export type CreateWebhookEndpointParams = SchemaCreateWebhookEndpointRequest;
export type Dispute = SchemaDispute;
export type DisputeList = SchemaDisputeList;
export type ErrorEnvelope = SchemaError;
export type ListEnvelope = SchemaListEnvelope;
export type Me = SchemaMe;
export type Payment = SchemaPayment;
export type PaymentParams = SchemaPaymentRequest;
export type RefundParams = SchemaRefundRequest;
export type Transaction = SchemaTransaction;
export type TransactionList = SchemaTransactionList;
export type TransactionStatus = SchemaTransactionStatus;
export type UpdateWebhookEndpointParams = SchemaUpdateWebhookEndpointRequest;
export type WebhookDelivery = SchemaWebhookDelivery;
export type WebhookDeliveryList = SchemaWebhookDeliveryList;
export type WebhookEndpoint = SchemaWebhookEndpoint;
export type WebhookEndpointList = SchemaWebhookEndpointList;
export type WebhookEndpointWithSecret = SchemaWebhookEndpointWithSecret;
export type WebhookEvent = SchemaWebhookEvent;
export type WebhookEventType = SchemaWebhookEventType;

/**
 * The machine-readable half of an error body. Switch on this, never on
 * `message`, which is written for humans and may be reworded at any time.
 */
export type ErrorCode = NonNullable<SchemaError['error']>['code'];
