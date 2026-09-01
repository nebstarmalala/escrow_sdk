# Cross-language fixtures

Three JSON files that every implementation of this API's client behaviour runs:
the TypeScript SDK, the PHP SDK, and the Go backend itself.

## Why they exist

Two SDKs that agree with each other prove nothing. They can be wrong together —
and they will be, because they are written by the same person from the same
reading of the same spec, on the same day. Checking one against the other only
confirms that the misreading was consistent.

So nothing here is captured from an implementation. The signature vectors are
computed independently in Python, and the anchor case matches a value that was
already independently derived and committed in the backend's own test. Three
implementations pinned to one artefact is a claim worth something; three
implementations pinned to each other is a tautology.

## The files

### `signatures.json`

The webhook signature scheme. `sign` cases give secrets, a timestamp and a body,
and the exact header that must come out. `verify` cases give a header, a body, a
clock and a tolerance, and whether verification must succeed.

The cases that matter most are the ones that look like padding:

- **`utf8_body`** — the MAC is over UTF-8 bytes. JavaScript strings are UTF-16
  and PHP strings are already bytes, so this is where a natural implementation
  in each language quietly diverges — and it diverges only for merchants whose
  product titles are not ASCII, which is not a group anyone tests with.
- **`accepts_exactly_at_the_tolerance_boundary`** — pins the comparison as
  inclusive, so three implementations cannot end up one second apart.
- **`rejects_a_future_timestamp`** — checking only that a timestamp is not too
  old is the common half-implementation.
- **`accepts_a_header_with_whitespace_after_commas`** — proxies reformat header
  values.

### `events.json`

One sample delivery body per public event type, plus a test-mode delivery.

These are validated, not merely written: the backend test decodes every one into
the real `partnerapi.PartnerTransaction` / `PartnerDispute` / `partnerwebhook.Event`
structs **with unknown fields disallowed**. A field invented here fails the
backend build rather than teaching an SDK a shape the server never sends.

### `errors.json`

One response per error code, with the `error_class` both SDKs must map it to and
the `retryable` decision both must make.

`retryable` is deliberately narrow — `429`, `5xx` and transport failures only.
Every `409` is left to the caller, including the "still in flight" case that is
technically safe to repeat: a plain `CONFLICT` also covers a duplicate
`partner_reference`, the two differ only in a human-readable message that nothing
may switch on, and auto-retrying would paper over a duplicate-order bug.

## The contract

A fixture file is **append-only in effect**. Adding a case is routine. Changing
an expected value in `signatures.json` means the wire format changed, which
breaks every deployed integration — that is a `/partner/v2` conversation, not a
patch release.

Every implementation must:

1. Run **all** cases in a file, not a chosen subset.
2. Fail if the file contains a case it does not understand, rather than skipping
   it. A silently ignored case is worse than no case, because it reads as
   coverage.
3. Fail if an event type or error code exists in the API but has no fixture — the
   catalog is part of what is being pinned.

Point 2 is the one that gets dropped. A test that loops over cases and only
asserts the ones it recognises will go green forever after someone adds a case it
has never heard of.

## Adding a language

A fourth implementation needs no code from here — just these three files and the
rules above. That is the intended cost of a Python or Ruby client: read the
fixtures, satisfy them, and the wire behaviour is settled before any endpoint is
written.
