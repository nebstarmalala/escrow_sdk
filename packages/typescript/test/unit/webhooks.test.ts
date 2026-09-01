import { describe, expect, it } from 'vitest';

import { signPayload, verify, WebhookSignatureError } from '../../src/webhooks.js';
import { assertNoUnknownKeys, loadFixture } from '../fixtures.js';

interface SignCase {
  name: string;
  why?: string;
  secrets: string[];
  timestamp: number;
  body: string;
  expected_header: string;
}

interface VerifyCase {
  name: string;
  why?: string;
  secret: string;
  header: string;
  body: string;
  now: number;
  tolerance_seconds: number;
  expected: boolean;
}

interface SignatureFixtures {
  $schema_version: number;
  $description: string;
  algorithm: Record<string, unknown>;
  sign: SignCase[];
  verify: VerifyCase[];
}

const SIGN_KEYS = ['name', 'why', 'secrets', 'timestamp', 'body', 'expected_header'] as const;
const VERIFY_KEYS = [
  'name',
  'why',
  'secret',
  'header',
  'body',
  'now',
  'tolerance_seconds',
  'expected',
] as const;

const fx = loadFixture<SignatureFixtures>('signatures.json');

describe('signatures.json', () => {
  it('is a schema version this SDK understands', () => {
    expect(fx.$schema_version).toBe(1);
    expect(fx.sign.length).toBeGreaterThan(0);
    expect(fx.verify.length).toBeGreaterThan(0);
  });

  describe('sign', () => {
    it.each(fx.sign.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
      assertNoUnknownKeys(
        c as unknown as Record<string, unknown>,
        SIGN_KEYS,
        `signatures.json sign case "${c.name}"`,
      );

      const header = await signPayload(c.secrets, new Date(c.timestamp * 1000), c.body);
      expect(header, c.why).toBe(c.expected_header);
    });
  });

  describe('verify', () => {
    it.each(fx.verify.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
      assertNoUnknownKeys(
        c as unknown as Record<string, unknown>,
        VERIFY_KEYS,
        `signatures.json verify case "${c.name}"`,
      );

      const attempt = verify(c.body, c.header, c.secret, {
        toleranceSeconds: c.tolerance_seconds,
        now: new Date(c.now * 1000),
      });

      if (c.expected) {
        // Every fixture body is a JSON object, so a pass also proves the
        // verified bytes were handed back parsed rather than re-read.
        await expect(attempt, c.why).resolves.toBeTypeOf('object');
      } else {
        await expect(attempt, c.why).rejects.toBeInstanceOf(WebhookSignatureError);
      }
    });
  });
});

describe('verification failures a merchant will actually hit', () => {
  const secret = 'whsec_testsecrettestsecrettestsecrettestsecret';
  const body = '{"id":"evt_1","type":"transaction.funded"}';
  const at = new Date(1_755_820_800_000);

  it('names the re-serialised body as the likely cause', async () => {
    const header = await signPayload([secret], at, body);
    // What a merchant does when they let their framework parse JSON first:
    // same data, different bytes.
    const reserialised = JSON.stringify(JSON.parse(body));

    await expect(
      verify(`${reserialised} `, header, secret, { now: at }),
    ).rejects.toThrow(/raw bytes/);
  });

  it('rejects an API key used as a signing secret, with an explanation', async () => {
    const header = await signPayload([secret], at, body);

    await expect(verify(body, header, `sk_test_${'a'.repeat(43)}`, { now: at })).rejects.toThrow(
      /whsec_/,
    );
  });

  it('rejects a missing header rather than treating it as unsigned', async () => {
    await expect(verify(body, undefined, secret, { now: at })).rejects.toThrow(
      /no Escrow-Signature header/,
    );
    await expect(verify(body, null, secret, { now: at })).rejects.toThrow(/no Escrow-Signature/);
  });

  it('verifies raw bytes as readily as a string', async () => {
    // Express with express.raw() hands you a Buffer, not a string.
    const bytes = new TextEncoder().encode(body);
    const header = await signPayload([secret], at, bytes);

    const event = await verify(bytes, header, secret, { now: at });
    expect((event as { id: string }).id).toBe('evt_1');
  });

  it('verifies a body whose bytes are not ASCII', async () => {
    // Where a UTF-16-length-based implementation silently diverges - and it
    // diverges only for merchants whose product titles are not ASCII.
    const unicode = '{"title":"Café ☕ naïve"}';
    const header = await signPayload([secret], at, unicode);

    await expect(verify(unicode, header, secret, { now: at })).resolves.toBeTypeOf('object');
  });

  it('reports a verified body that is not JSON distinctly from a bad signature', async () => {
    const notJson = 'this verified but is not json';
    const header = await signPayload([secret], at, notJson);

    await expect(verify(notJson, header, secret, { now: at })).rejects.toThrow(
      /verified but is not valid JSON/,
    );
  });
});

describe('event payloads', () => {
  interface EventFixtures {
    $schema_version: number;
    $description: string;
    events: { id: string; type: string; livemode: boolean; data: { object: unknown } }[];
  }

  const events = loadFixture<EventFixtures>('events.json');
  const secret = 'whsec_testsecrettestsecrettestsecrettestsecret';

  it.each(events.events.map((e) => [e.type, e] as const))(
    'round-trips a %s delivery',
    async (_type, event) => {
      const at = new Date(1_755_820_800_000);
      const raw = JSON.stringify(event);
      const header = await signPayload([secret], at, raw);

      const parsed = await verify(raw, header, secret, { now: at });

      expect(parsed.id).toBe(event.id);
      expect(parsed.type).toBe(event.type);
      expect(parsed.livemode).toBe(event.livemode);
      expect(parsed.data.object).toEqual(event.data.object);
    },
  );

  it('exposes livemode on the envelope so a test delivery is filterable', () => {
    const sandbox = events.events.filter((e) => !e.livemode);
    // Without a test-mode fixture, nothing stops an SDK assuming livemode is
    // always true and a merchant acting on a sandbox event with real stock.
    expect(sandbox.length).toBeGreaterThan(0);
  });
});
