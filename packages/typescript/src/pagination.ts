import type { HttpClient } from './http.js';

/**
 * One page of a keyset-paginated list.
 *
 * The API pages on `starting_after` rather than an offset, so a page boundary
 * cannot drift while you walk it: new objects appear at the front, and the
 * cursor is anchored to the last id you actually saw.
 */
export interface Page<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor?: string | null;
}

export interface ListParams {
  /** 1-100. The API clamps out-of-range values rather than erroring. */
  limit?: number | undefined;
  /** The last id from the previous page. Usually easier to let the iterator handle. */
  starting_after?: string | undefined;
}

/**
 * A lazily-paged list.
 *
 * `for await (const txn of escrow.transactions.list())` walks every page; the
 * next request is only made when the current page runs out, so breaking out of
 * the loop early costs nothing. `await list.page()` gets a single page for
 * anyone who wants to drive the cursor themselves.
 */
export class ListResult<T> implements AsyncIterable<T> {
  constructor(
    private readonly http: HttpClient,
    private readonly path: string,
    private readonly query: Record<string, string | number | boolean | undefined>,
  ) {}

  /** Fetches exactly one page, starting from `cursor` if given. */
  async page(cursor?: string): Promise<Page<T>> {
    const response = await this.http.request<Page<T>>({
      method: 'GET',
      path: this.path,
      query: cursor === undefined ? this.query : { ...this.query, starting_after: cursor },
    });
    return response.data;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor: string | undefined = this.query['starting_after'] as string | undefined;
    let guard = 0;

    for (;;) {
      const page: Page<T> = await this.page(cursor);

      for (const item of page.data) {
        yield item;
      }

      if (!page.has_more) return;

      const next = page.next_cursor;
      // has_more without a usable cursor would otherwise spin forever on the
      // same page. Stopping is the honest response: the alternative is an
      // integration that looks like it is working while it refetches page one.
      if (next === undefined || next === null || next === '') return;
      if (next === cursor) return;

      cursor = next;

      // A server bug that always reports another page would hang a merchant's
      // checkout rather than fail it. 10,000 pages is far past any real list.
      if (++guard > 10_000) {
        throw new Error(
          `pagination did not terminate after ${guard} pages of ${this.path}; ` +
            'this is a bug in the API, not in your code',
        );
      }
    }
  }

  /**
   * Collects every page into one array.
   *
   * Convenient, and a liability on a large account: it holds the whole list in
   * memory and cannot start work until the last page arrives. Prefer iterating.
   */
  async all(): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) out.push(item);
    return out;
  }
}
