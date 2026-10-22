// Drives the TypeScript SDK through a full test-mode lifecycle against a live
// backend, then hands the same key to the PHP SDK and does it again.
//
// This is the layer the fixtures cannot reach. Shared vectors prove the three
// implementations compute the same signature; mock servers prove each client
// handles a scripted response. Neither proves the request a client actually
// builds is one the API accepts - the wrong header name, a query parameter
// spelled differently, a body the server rejects. That only shows up here.
//
//   node e2e/run.mjs --key sk_test_... [--base http://localhost:8080]
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    base: { type: 'string', default: 'http://localhost:8080' },
    'skip-php': { type: 'boolean', default: false },
  },
});

if (values.key === undefined) {
  console.error('usage: node e2e/run.mjs --key sk_test_... [--base URL]');
  process.exit(2);
}

// pathToFileURL, not a raw path: a Windows absolute path starts with a drive
// letter, which the ESM loader reads as an unsupported URL scheme.
const { Escrow } = await import(
  pathToFileURL(resolve(here, '../packages/typescript/dist/index.js')).href
);

const escrow = new Escrow({ apiKey: values.key, baseUrl: values.base, maxRetries: 1 });

let failures = 0;

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`  PASS  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('typescript SDK against a live backend');

if (escrow.livemode) {
  console.error('refusing to run: that is a LIVE key');
  process.exit(2);
}

let txnId;
const orderId = `e2e_${Date.now()}`;
const phone = `+2547${String(Date.now()).slice(-8)}`;

await step('authenticates and reports test mode', async () => {
  const me = await escrow.me();
  if (me.livemode !== false) throw new Error('expected livemode false');
  return `partner ${me.partner_id}`;
});

await step('creates a transaction', async () => {
  const result = await escrow.transactions.create(
    {
      partner_reference: orderId,
      amount_minor: 250_000,
      title: 'E2E headphones',
      description: 'Created by the SDK end-to-end harness',
      item_type: 'PHYSICAL',
      category: 'electronics',
      buyer: { phone, full_name: 'E2E Shopper' },
      delivery_method: 'COURIER',
      delivery_timeline: '3-5 days',
      metadata: { harness: 'e2e' },
    },
    { idempotencyKey: orderId },
  );

  txnId = result.transaction.id;
  if (result.transaction.livemode !== false) throw new Error('a test key produced a live transaction');
  if (result.replayed) throw new Error('a first create should not be a replay');
  return `${result.transaction.reference} (${result.transaction.status})`;
});

await step('replays an identical create instead of making a second escrow', async () => {
  const again = await escrow.transactions.create(
    {
      partner_reference: orderId,
      amount_minor: 250_000,
      title: 'E2E headphones',
      description: 'Created by the SDK end-to-end harness',
      item_type: 'PHYSICAL',
      category: 'electronics',
      buyer: { phone, full_name: 'E2E Shopper' },
      delivery_method: 'COURIER',
      delivery_timeline: '3-5 days',
      metadata: { harness: 'e2e' },
    },
    { idempotencyKey: orderId },
  );

  if (!again.replayed) throw new Error('expected Idempotent-Replay: true');
  if (again.transaction.id !== txnId) throw new Error('replay returned a different transaction');
  return 'same id, Idempotent-Replay: true';
});

await step('rejects the same key with a different body', async () => {
  try {
    await escrow.transactions.create(
      {
        partner_reference: orderId,
        amount_minor: 999_900, // different
        title: 'E2E headphones',
        description: 'Created by the SDK end-to-end harness',
        item_type: 'PHYSICAL',
        category: 'electronics',
        buyer: { phone, full_name: 'E2E Shopper' },
        delivery_method: 'COURIER',
        delivery_timeline: '3-5 days',
      },
      { idempotencyKey: orderId },
    );
    throw new Error('expected a 409');
  } catch (err) {
    if (err.code !== 'IDEMPOTENCY_CONFLICT') throw err;
    return err.code;
  }
});

await step('retrieves the transaction', async () => {
  const txn = await escrow.transactions.retrieve(txnId);
  if (txn.id !== txnId) throw new Error('wrong transaction');
  return txn.status;
});

await step('masks the buyer contact it was given', async () => {
  const txn = await escrow.transactions.retrieve(txnId);
  const buyer = JSON.stringify(txn.buyer ?? {});
  if (buyer.includes(phone)) {
    throw new Error(`the raw buyer phone came back in the response: ${buyer}`);
  }
  return buyer;
});

await step('lists the transaction through the cursor iterator', async () => {
  let found = false;
  for await (const txn of escrow.transactions.list({ limit: 5 })) {
    if (txn.id === txnId) {
      found = true;
      break;
    }
  }
  if (!found) throw new Error('the created transaction was not in the list');
  return 'found on the first page';
});

await step('404s on an id that does not exist', async () => {
  try {
    await escrow.transactions.retrieve('01a05e5c-0000-7000-8000-000000000000');
    throw new Error('expected a 404');
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
    return err.code;
  }
});

await step('422s on a validation failure the API owns', async () => {
  try {
    await escrow.transactions.create(
      {
        partner_reference: `${orderId}_bad`,
        amount_minor: 250_001, // not a whole shilling
        title: 'E2E headphones',
        description: 'x',
        item_type: 'PHYSICAL',
        category: 'electronics',
        buyer: { phone: `${phone}9` },
        delivery_method: 'COURIER',
        delivery_timeline: '3-5 days',
      },
      { idempotencyKey: `${orderId}_bad` },
    );
    throw new Error('expected a 422');
  } catch (err) {
    if (err.status !== 422) throw err;
    return `${err.code}: ${err.message}`;
  }
});

await step('registers and deletes a webhook endpoint', async () => {
  const endpoint = await escrow.webhookEndpoints.create({
    url: 'https://example.com/webhooks/escrow',
    event_types: ['transaction.funded'],
  });
  if (typeof endpoint.signing_secret !== 'string' || !endpoint.signing_secret.startsWith('whsec_')) {
    throw new Error('no signing secret came back on create');
  }
  await escrow.webhookEndpoints.del(endpoint.id);
  return 'created, secret returned once, deleted';
});

await step('refuses a webhook URL pointing at private space', async () => {
  try {
    // https, so the scheme check passes and the address check is the thing
    // actually under test. With http it was rejected for being http, and the
    // SSRF guard never ran.
    await escrow.webhookEndpoints.create({ url: 'https://169.254.169.254/latest/meta-data/' });
    throw new Error('the API accepted a link-local webhook URL');
  } catch (err) {
    if (err.status !== 422) throw err;
    return `${err.code}: ${err.message}`;
  }
});

if (!values['skip-php']) {
  console.log('\nphp SDK against the same live backend');

  // tools/php.sh falls back to a container when no local PHP exists. Only in
  // that case is localhost inside the PHP runtime different from the host.
  // Keep the merchant SDK's base URL untouched when PHP runs locally.
  let localPhp = false;
  try {
    execFileSync('bash', ['-lc', 'command -v php >/dev/null 2>&1'], {
      cwd: resolve(here, '..'),
      stdio: 'ignore',
    });
    localPhp = true;
  } catch {
    // The wrapper will use its container fallback.
  }
  const phpBase = localPhp
    ? values.base
    : values.base.replace(
        /^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/,
        '$1host.docker.internal',
      );
  if (phpBase !== values.base) {
    console.log(`  (php runs in a container; using ${phpBase})`);
  }

  try {
    const out = execFileSync(
      'bash',
      ['tools/php.sh', '../../e2e/php-lifecycle.php', values.key, phpBase],
      { cwd: resolve(here, '..'), encoding: 'utf8' },
    );
    process.stdout.write(out);
    if (out.includes('FAIL')) failures++;
  } catch (err) {
    failures++;
    console.log('  FAIL  the PHP harness did not complete');
    console.log(String(err.stdout ?? err.message));
  }
}

console.log(failures === 0 ? '\nall end-to-end checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
