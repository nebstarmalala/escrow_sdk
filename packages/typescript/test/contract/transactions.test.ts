import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Escrow } from '../../src/client.js';
import { StubServer } from './stub.js';

const TEST_KEY = 'sk_test_' + 'a'.repeat(43);

let stub: StubServer;
let escrow: Escrow;

beforeEach(async () => {
  stub = new StubServer();
  const baseUrl = await stub.start();
  escrow = new Escrow({ apiKey: TEST_KEY, baseUrl, maxRetries: 0, timeoutMs: 2_000 });
});

afterEach(async () => {
  await stub.stop();
});

const TXN = {
  id: '0199a3f2-6c1e-7c8e-9f2a-3b4c5d6e7f80',
  object: 'transaction',
  reference: 'ESC-8H2K4M',
  status: 'funded',
  amount_minor: 250000,
  fee_minor: 7500,
  payable_minor: 257500,
  currency: 'KES',
  livemode: false,
  created_at: '2026-09-01T09:12:41Z',
  updated_at: '2026-09-01T09:15:04Z',
};

const PARAMS = {
  partner_reference: 'order_10245',
  amount_minor: 250000,
  title: 'Sony WH-1000XM5',
  description: 'Wireless headphones',
  item_type: 'PHYSICAL',
  category: 'electronics',
  buyer: { phone: '+254700111222' },
  delivery_method: 'COURIER',
  delivery_timeline: '3-5 days',
} as const;

describe('creating a transaction', () => {
  it('POSTs to the transactions collection with an idempotency key', async () => {
    stub.script({ status: 201, body: { transaction: TXN, payment: null } });

    await escrow.transactions.create({ ...PARAMS });

    const req = stub.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/partner/v1/transactions');
    // Generated when the caller does not supply one. The API requires a key on
    // this route, so omitting it would be a 422 rather than a convenience.
    expect(req.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the caller\'s key when given one', async () => {
    stub.script({ status: 201, body: { transaction: TXN, payment: null } });

    await escrow.transactions.create({ ...PARAMS }, { idempotencyKey: 'order_10245' });

    expect(stub.requests[0]!.headers['idempotency-key']).toBe('order_10245');
  });

  it('returns payment: null for a shopper who already has an escrow account', async () => {
    stub.script({
      status: 201,
      body: { transaction: { ...TXN, status: 'pending_acceptance' }, payment: null },
    });

    const result = await escrow.transactions.create({ ...PARAMS });

    // Not an error, and it does not throw. The escrow exists, nothing has been
    // charged, and the shopper accepts in their own app. An integration that
    // ignores this branch has orders that silently never fund.
    expect(result.transaction.status).toBe('pending_acceptance');
    expect(result.payment).toBeNull();
  });

  it('returns a failed payment without throwing', async () => {
    stub.script({
      status: 201,
      body: {
        transaction: { ...TXN, status: 'accepted' },
        payment: { object: 'payment', status: 'failed', failure_reason: 'provider timeout' },
      },
    });

    const result = await escrow.transactions.create({ ...PARAMS });

    // The escrow exists and is accepted. Throwing here would strand it: the
    // merchant would have no id, and would create a second one on retry.
    expect(result.payment?.status).toBe('failed');
    expect(result.transaction.status).toBe('accepted');
  });

  it('reports when the API replayed a stored response', async () => {
    stub.script({
      status: 201,
      headers: { 'Idempotent-Replay': 'true' },
      body: { transaction: TXN, payment: null },
    });

    const result = await escrow.transactions.create({ ...PARAMS }, { idempotencyKey: 'order_1' });

    expect(result.replayed).toBe(true);
    expect(result.transaction.id).toBe(TXN.id);
  });
});

describe('transaction actions', () => {
  it.each([
    ['ship', (id: string) => escrow.transactions.ship(id), '/ship', undefined],
    ['cancel', (id: string) => escrow.transactions.cancel(id), '/cancel', undefined],
    [
      'pay',
      (id: string) => escrow.transactions.pay(id, { method: 'mpesa', phone: '+254700111222' }),
      '/payments',
      { method: 'mpesa', phone: '+254700111222' },
    ],
    [
      'refund',
      (id: string) => escrow.transactions.refund(id, { reason: 'out of stock' }),
      '/refund',
      { reason: 'out of stock' },
    ],
  ] as const)('%s posts to the right sub-resource', async (_name, call, suffix, body) => {
    stub.script({ status: 200, body: TXN });

    await call(TXN.id);

    const req = stub.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`/partner/v1/transactions/${TXN.id}${suffix}`);
    expect(req.headers['idempotency-key']).toBeDefined();

    if (body === undefined) {
      expect(req.body).toBe('');
    } else {
      expect(JSON.parse(req.body)).toEqual(body);
    }
  });

  it('sends an empty object when refunding with no reason', async () => {
    stub.script({ status: 200, body: TXN });

    await escrow.transactions.refund(TXN.id);

    expect(JSON.parse(stub.requests[0]!.body)).toEqual({});
  });

  it('wraps a refund rather than mixing replayed into the transaction', async () => {
    stub.script({ status: 200, headers: { 'Idempotent-Replay': 'true' }, body: TXN });

    const result = await escrow.transactions.refund(TXN.id);

    // A stray boolean sitting inside a transaction object is the kind of thing
    // that ends up serialised into a merchant's database by accident. The PHP
    // SDK returns this same shape.
    expect(result.transaction.id).toBe(TXN.id);
    expect(result.replayed).toBe(true);
    expect('replayed' in result.transaction).toBe(false);
  });

  it('escapes an id rather than splicing it into the path', async () => {
    stub.script({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'no' } } });

    await escrow.transactions.retrieve('../me').catch(() => undefined);

    // A caller passing an id straight from their own database should not be
    // able to walk out of the resource.
    expect(stub.requests[0]!.url).toBe('/partner/v1/transactions/..%2Fme');
  });
});

describe('there is no release', () => {
  it('exposes no method that could release funds to the merchant', () => {
    // Structural, not a comment. Buyer-only release is the product: the
    // shopper's confidence rests on the merchant being unable to decide it.
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(escrow.transactions)),
      ...Object.keys(escrow.transactions),
    ];

    expect(names.filter((n) => /release/i.test(n))).toEqual([]);
  });
});

describe('listing', () => {
  it('passes a status filter through to the query', async () => {
    stub.script({ status: 200, body: { object: 'list', data: [TXN], has_more: false } });

    await escrow.transactions.list({ status: 'funded', limit: 10 }).all();

    expect(stub.requests[0]!.url).toBe('/partner/v1/transactions?limit=10&status=funded');
  });
});

describe('webhook endpoints', () => {
  const ENDPOINT = {
    id: '0199a400-1111-7abc-8def-0123456789ab',
    object: 'webhook_endpoint',
    url: 'https://shop.example/webhooks/escrow',
    livemode: false,
    event_types: [],
    status: 'ENABLED',
    created_at: '2026-09-01T09:00:00Z',
  };

  it('creates, updates, deletes and rotates against the right routes', async () => {
    stub.then({ status: 200, body: { ...ENDPOINT, signing_secret: 'whsec_x' } });

    await escrow.webhookEndpoints.create({ url: ENDPOINT.url });
    await escrow.webhookEndpoints.update(ENDPOINT.id, { description: 'primary receiver' });
    await escrow.webhookEndpoints.del(ENDPOINT.id);
    await escrow.webhookEndpoints.rotateSecret(ENDPOINT.id);

    expect(stub.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /partner/v1/webhook_endpoints',
      `PATCH /partner/v1/webhook_endpoints/${ENDPOINT.id}`,
      `DELETE /partner/v1/webhook_endpoints/${ENDPOINT.id}`,
      `POST /partner/v1/webhook_endpoints/${ENDPOINT.id}/rotate_secret`,
    ]);
  });

  it('filters deliveries by endpoint and status', async () => {
    stub.script({ status: 200, body: { object: 'list', data: [], has_more: false } });

    await escrow.webhookDeliveries
      .list({ endpoint_id: ENDPOINT.id, status: 'FAILED', limit: 50 })
      .all();

    expect(stub.requests[0]!.url).toBe(
      `/partner/v1/webhook_deliveries?limit=50&endpoint_id=${ENDPOINT.id}&status=FAILED`,
    );
  });
});
