import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Escrow } from '../../src/client.js';
import { ListResult } from '../../src/pagination.js';
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

interface Item {
  id: string;
}

function list(query: Record<string, string | number | undefined> = {}): ListResult<Item> {
  return new ListResult<Item>(escrow.transport, '/partner/v1/transactions', query);
}

const page = (ids: string[], hasMore: boolean): unknown => ({
  object: 'list',
  data: ids.map((id) => ({ id })),
  has_more: hasMore,
  next_cursor: hasMore ? ids[ids.length - 1] : null,
});

describe('cursor pagination', () => {
  it('walks every page exactly once', async () => {
    stub.script(
      { status: 200, body: page(['a', 'b'], true) },
      { status: 200, body: page(['c', 'd'], true) },
      { status: 200, body: page(['e'], false) },
    );

    const seen: string[] = [];
    for await (const item of list()) seen.push(item.id);

    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(stub.requests).toHaveLength(3);
  });

  it('passes the previous page\'s last id as starting_after', async () => {
    stub.script(
      { status: 200, body: page(['a', 'b'], true) },
      { status: 200, body: page(['c'], false) },
    );

    await list({ limit: 2 }).all();

    expect(stub.requests[0]!.url).toBe('/partner/v1/transactions?limit=2');
    expect(stub.requests[1]!.url).toBe('/partner/v1/transactions?limit=2&starting_after=b');
  });

  it('stops fetching as soon as the caller breaks out', async () => {
    stub.script({ status: 200, body: page(['a', 'b'], true) }).then({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'a second page was fetched' } },
    });

    const seen: string[] = [];
    for await (const item of list()) {
      seen.push(item.id);
      break;
    }

    expect(seen).toEqual(['a']);
    // Lazy paging is the point: a merchant scanning for one transaction should
    // not pull their whole history to find it.
    expect(stub.requests).toHaveLength(1);
  });

  it('terminates when the API claims another page but sends no cursor', async () => {
    // A server bug. Looping on it would refetch page one forever while looking
    // like healthy progress, so stopping is the honest response.
    stub.then({
      status: 200,
      body: { object: 'list', data: [{ id: 'a' }], has_more: true, next_cursor: null },
    });

    const seen = await list().all();

    expect(seen.map((i) => i.id)).toEqual(['a']);
    expect(stub.requests).toHaveLength(1);
  });

  it('terminates when the cursor does not advance', async () => {
    stub.then({
      status: 200,
      body: { object: 'list', data: [{ id: 'a' }], has_more: true, next_cursor: 'a' },
    });

    const seen = await list({ starting_after: 'a' }).all();

    expect(seen.map((i) => i.id)).toEqual(['a']);
    expect(stub.requests).toHaveLength(1);
  });

  it('handles an empty first page', async () => {
    stub.script({ status: 200, body: { object: 'list', data: [], has_more: false } });

    expect(await list().all()).toEqual([]);
  });

  it('exposes a single page for callers driving the cursor themselves', async () => {
    stub.script({ status: 200, body: page(['a', 'b'], true) });

    const first = await list().page();

    expect(first.data.map((i) => i.id)).toEqual(['a', 'b']);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe('b');
    expect(stub.requests).toHaveLength(1);
  });
});
