import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface StubReply {
  status: number;
  /** A string is sent verbatim; anything else is JSON-encoded. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Milliseconds to wait before replying, for timeout tests. */
  delayMs?: number;
  /** Milliseconds to wait after headers, for response-body timeout tests. */
  bodyDelayMs?: number;
}

/**
 * A real HTTP server that replays a scripted sequence of replies.
 *
 * Deliberately a real server rather than a stubbed `fetch`: the behaviour under
 * test is header handling, status codes, timeouts and connection failures, and
 * a stubbed `fetch` would be testing the stub's idea of those rather than the
 * runtime's.
 */
export class StubServer {
  private server: Server | undefined;
  private replies: StubReply[] = [];
  readonly requests: RecordedRequest[] = [];
  private fallback: StubReply = { status: 500, body: { error: { code: 'INTERNAL', message: 'stub ran out of scripted replies' } } };

  /** Sets the scripted replies, consumed in order. */
  script(...replies: StubReply[]): this {
    this.replies = [...replies];
    return this;
  }

  /** Used once the script is exhausted. */
  then(reply: StubReply): this {
    this.fallback = reply;
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });

    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    this.requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
      ),
      body: Buffer.concat(chunks).toString('utf8'),
    });

    const reply = this.replies.shift() ?? this.fallback;

    if (reply.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    }

    const payload =
      reply.body === undefined
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);

    res.writeHead(reply.status, {
      'Content-Type': 'application/json',
      ...(reply.headers ?? {}),
    });

    if (reply.bodyDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, reply.bodyDelayMs));
    }

    res.end(payload);
  }
}
