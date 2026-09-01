import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../shared/fixtures');

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8')) as T;
}

/**
 * Asserts that an object contains no key this implementation does not handle.
 *
 * The fixture contract requires it: a test that loops over cases and quietly
 * ignores the ones it does not recognise will stay green forever after someone
 * adds a case it has never heard of, while reading as coverage.
 */
export function assertNoUnknownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(obj).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `${where} contains ${unknown.map((k) => `"${k}"`).join(', ')}, which this SDK does not ` +
        'handle. Either implement it or remove it - do not widen the allowed key list to ' +
        'make this pass.',
    );
  }
}
