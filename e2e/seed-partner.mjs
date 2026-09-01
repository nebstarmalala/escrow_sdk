// Provisions a partner and a test-mode API key, and prints the raw key.
//
// It writes to Postgres directly rather than driving the admin API, and that is
// a deliberate scope decision, not a shortcut around auth. Admin provisioning
// starts with `--mode=admin-bootstrap`, which prints a one-time invite link that
// a human then uses to set a password and enrol MFA. Automating that would be
// testing the admin onboarding flow; what this harness is for is exercising the
// SDKs against a live API.
//
// The key material is generated exactly as the backend does it:
//
//   sk_test_<43 chars of base64url(32 random bytes)>
//   key_prefix = the first 12 chars of the body   (non-secret, UNIQUE-indexed)
//   key_hash   = sha256 of the WHOLE string, sk_test_ prefix included
//
// Hashing the prefix along with the body is what stops a test key ever
// validating as a live one.
//
//   node e2e/seed-partner.mjs            # prints the raw key
//   node e2e/seed-partner.mjs --live     # a live key, for completeness
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const live = process.argv.includes('--live');
const prefix = live ? 'sk_live_' : 'sk_test_';

// UUIDv7 is what the backend mints, and the partner API's cursor pagination
// relies on that ordering. v4 would still work here, but seeded rows that sort
// differently from real ones make a paging bug look like a paging feature.
function uuidv7() {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) {
    bytes[5 - i] = Number((ms >> BigInt(8 * i)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const body = randomBytes(32).toString('base64url'); // 43 chars
const rawKey = prefix + body;
const keyPrefix = body.slice(0, 12);
const keyHash = createHash('sha256').update(rawKey).digest('hex');
const lastFour = body.slice(-4);

const sellerId = uuidv7();
const sandboxSellerId = uuidv7();
const partnerId = uuidv7();
const keyId = uuidv7();
const stamp = Date.now();
const slug = `e2e-${stamp}`;

const sql = `
BEGIN;

INSERT INTO users (id, email, full_name, role, is_verified, is_guest, is_sandbox)
VALUES ('${sellerId}', 'e2e-seller-${stamp}@example.test', 'E2E Merchant', 'SELLER', true, false, false);

-- The sandbox seller is a separate user carrying is_sandbox, and the wallet
-- service refuses withdrawals for it. That single guard is the only thing
-- between test-mode escrow and real money.
INSERT INTO users (id, email, full_name, role, is_verified, is_guest, is_sandbox)
VALUES ('${sandboxSellerId}', 'e2e-sandbox-${stamp}@example.test', 'E2E Merchant (sandbox)', 'SELLER', true, false, true);

INSERT INTO partners (id, name, slug, seller_user_id, sandbox_seller_user_id, status, contact_email, rate_limit_per_min)
VALUES ('${partnerId}', 'E2E Merchant', '${slug}', '${sellerId}', '${sandboxSellerId}', 'ACTIVE', 'e2e@example.test', 600);

INSERT INTO partner_api_keys (id, partner_id, name, livemode, key_prefix, key_hash, last_four, scopes)
VALUES (
  '${keyId}', '${partnerId}', 'e2e', ${live},
  '${keyPrefix}', '${keyHash}', '${lastFour}',
  ARRAY['transactions:read','transactions:write','disputes:read','webhooks:manage','events:read']
);

COMMIT;
`;

execFileSync(
  'docker',
  ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'escrow', '-d', 'escrow', '-v', 'ON_ERROR_STOP=1', '-q'],
  { input: sql, cwd: process.env.BACKEND_DIR ?? '../escrow-backend', stdio: ['pipe', 'inherit', 'inherit'] },
);

console.log(
  JSON.stringify(
    { partner_id: partnerId, slug, seller_user_id: sellerId, api_key: rawKey, livemode: live },
    null,
    2,
  ),
);
