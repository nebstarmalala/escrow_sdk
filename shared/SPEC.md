# The spec copy

`partner-openapi.yaml` in this directory is a **copy** of the frozen contract
that lives in the backend repository. It is the single input to type generation
for both packages.

| | |
|---|---|
| Source | `escrow-backend:api/partner-openapi.yaml` |
| Backend commit | `74db6d2279df642bc839bf6d5d89654a8b18baec` (2026-09-01) |
| API version | `1.0.0` |
| sha256 | `a2f288510e5859b461da9e1aae591147f5fd58ec249c59426d9d74a8a6264a7a` |

## Why a copy and not a submodule

The SDK must build without a backend checkout. A submodule would make every
`npm install` in this repo depend on access to a second repository, including in
the CI of anyone who forks it.

The cost of copying is drift, which is why the hash above is recorded and
checked. `npm run spec:check` in `packages/typescript` recomputes it.

## Updating it

The spec is **frozen**. Only additive changes ship under `1.0.0` — new optional
response fields, new endpoints, new event types. Anything that could break a
working integration goes to `/partner/v2`.

To take in an additive change:

1. Copy the file over from the backend repo.
2. Update the commit, version and sha256 in the table above.
3. Regenerate types in both packages (`npm run generate`, `make php-generate`).
4. Commit the regenerated output alongside the spec — CI fails if they disagree.

Do not hand-edit `partner-openapi.yaml`. A change made here and not in the
backend is a lie the type system will happily propagate to every integrator.
