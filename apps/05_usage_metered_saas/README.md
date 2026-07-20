# App 05 — Usage-Metered SaaS

Motoko canisterをSaaS control planeとして使うreferenceです。tenant、plan、quota period、hashed API key、authorized reporter、idempotent usage eventを管理します。

## Security model

- controller creates/changes tenants and reporters
- tenant or controller registers/revokes API key hashes
- reporter/controller records usage
- raw API key is never stored
- idempotency key is scoped to tenant
- quota is enforced before event append

## Important boundary

API key verification gateway、billing invoice、payment collectionはoff-chainまたはdedicated adapterです。canisterへraw keyを送らず、cryptographic hashを送ります。

## Monetization use

- API calls
- provenance verification
- batch anchoring
- organization seats
- evidence storage

## Production gaps

- delegated organization admin
- signed usage receipts
- billing invoice settlement
- key prefix/rotation UX
- certified usage export
- rate limiting by cycles/economic stake
