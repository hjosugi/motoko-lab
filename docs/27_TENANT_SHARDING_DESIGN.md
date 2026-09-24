# Tenant sharding, routing and the global hash index

Issue #23. Status: design, with an executable model
(`tools/sharding/model.mjs`, 61 checks in `tools/sharding/model.test.mjs`, run
offline in CI). Nothing here is deployed; the reference apps are single
canisters. [21_LARGEST_MOTOKO_SERVICE_BLUEPRINT.md](21_LARGEST_MOTOKO_SERVICE_BLUEPRINT.md)
names the canister roles; this document decides how they behave when messages
arrive in an order nobody chose.

A large service should scale by measured operational boundaries, not by one
giant canister and not by sharding before it has to. The trigger comes first.

## When to shard

A shard is split or a tenant moved when a measured limit is approached, not on
a schedule. The limits that matter for the registry, from what the kit already
measures:

| Signal | Source | Act at |
|---|---|---|
| heap / stable memory per canister | `canister_status`, #24 dashboards | 50% of the subnet's per-canister limit |
| instructions per reveal and per query page | `mops bench` (#3, #6), #30 | message limit ÷ 4 for the worst request |
| one tenant's share of a shard's update calls | per-tenant counters (#22, #24) | > 50% sustained: the hot-tenant path below |
| upgrade duration (enhanced persistence keeps upgrades independent of heap size, migrations are not) | #16 migration-chain measurements | a migration that would not finish in one upgrade |

#30 turns these into numbers per deployment; until it has, the thresholds are
the column above.

## Routing key and epoch

The routing key is the **tenant** — a creator identity (#7) or an organization —
optionally extended by a **collection** for a tenant too large for one shard.
Everything a tenant writes lives on one shard, so a tenant's history, export
(#19) and billing (#14) are shard-local operations.

The router holds `key → { shard, epoch, state }`. A client caches the route and
sends the epoch with every write. A shard refuses a write whose epoch it does
not hold, or for a key it no longer owns, and says where the key went:

```
write(key, epoch) on a shard:
  not owned              -> notOwned            (ask the router)
  moved out              -> redirect { to, epoch }
  epoch != owned.epoch   -> staleEpoch { epoch }
  frozen (moving)        -> moving              (retry later)
  otherwise              -> apply
```

A stale route costs one retry, never a misplaced record. The model's
stale-router case: a client holding a pre-move route is redirected once and its
write lands on the new shard; the old shard accepts nothing after the move.

A collection route is used when present, the tenant route otherwise, so a hot
tenant is split without changing anyone else's key.

## Authoritative writes and rebuildable indexes

| Authoritative (never rebuilt) | Rebuildable (derived only from events) |
|---|---|
| a shard's records, commitments, disputes, identity state, usage events, invoices | the global artifact-hash index |
| the shard's append-only event log, with a per-shard sequence number | cross-tenant search, counts, dashboards |
| the router table | archive copies |

Every authoritative write emits an event carrying the shard id and the next
sequence number. An index applies events **idempotently** (a redelivery is a
no-op), in **sequence per shard** (a gap is refused, and the subscriber
re-reads from its high-water mark), and **in any order across shards**. It
publishes its high-water mark per shard, so a verifier can see how current it
is.

Because the index is built only from events, rebuilding it is replaying every
shard's log from sequence 1. The model checks that an index built from 50
different interleavings, with every event delivered twice, is identical to one
rebuilt from the logs.

## The global artifact-hash rule

Within one canister, `reveal` refuses a second record for an artifact hash
(`#duplicate`). Across shards that refusal would need a lock on every reveal —
a call to a global canister before each write, which makes the global index a
single point of failure for every tenant. So:

1. **Each shard accepts** a reveal whose hash is new *to that shard*.
2. **The index resolves** duplicates deterministically: the claim with the
   smallest `(committedAt, shard id, commitment id)` holds the hash.
   Commitment time leads because the provenance question is "who committed
   first"; shard and commitment id only break exact ties.
3. **Nothing is deleted.** Later claims stay, reported as duplicates of the
   holder. A verifier shows both, earliest commitment first — the same
   "report, do not unwrite" rule as disputes (#8).

The result does not depend on which shard's event reached the index first: the
model delivers a three-way duplicate (two with the same commitment time) in all
six orders and gets the same holder and the same duplicate list every time.

A tenant that needs a hard guarantee — refuse rather than report — can opt into
**reserve-then-reveal**: reserve the hash at the index first, reveal within the
reservation's lifetime, and accept that reveals stop while the index is down.
That is an explicit trade of availability for exclusivity, per tenant, not the
default.

## Moving a tenant

A move is a sequence of idempotent steps recorded by the router, so an
interruption anywhere is finished by running the move again:

1. **freeze** — the router marks the key `moving`; the source refuses writes for
   it with the retryable `moving`;
2. **copy** — the target pulls the key's records in pages, each with a checksum
   (#19's export format), verifying every page;
3. **verify** — the copy is compared, by content hash, with the source; only
   then does the target own the key at epoch + 1;
4. **flip** — the router points the key at the target with the new epoch; the
   source keeps a `movedOut` tombstone that redirects, and its data read-only
   for a grace period; the target emits a `movedIn` event so billing and audit
   see when the tenant changed shard.

Record ids are namespaced by the shard that created them (`s1:17`), so a moved
record keeps its id. Its **certificates change issuer**: records certified by
the source canister (#6) stay valid for the time they were issued, and the
target re-certifies what it now serves. A verifier resolves a record to its
current shard through the router, never by assuming the canister in an old
certificate is still authoritative.

**Rehearsal plan.** Before any production move: (1) run the model's move and
interruption cases; (2) on pocket-ic, install two copies of the shard canister,
fill one with the #16 large-map fixture, move one tenant with an interruption
injected after the copy, and compare exports before and after; (3) repeat with
a write storm from a client holding the old route; (4) record the duration per
10,000 records, which bounds how long a tenant is frozen.

## Partial failures

| Failure | Behaviour |
|---|---|
| router stale | redirect / staleEpoch, one retry (model: stale router) |
| shard unavailable | that shard's tenants cannot write — refused outright, nothing half-applied; other tenants unaffected; the index keeps serving with a high-water mark that shows the silence (model: shard unavailable) |
| index behind or down | writes continue; duplicate resolution is late, not wrong — it is order-independent; verifiers see the high-water mark |
| event redelivered | no-op (sequence ≤ high-water mark) |
| event lost | the next event is a gap, refused; the subscriber re-reads the log from its high-water mark |
| move interrupted | re-run; each step is idempotent; writes stay `moving` until the flip (model: interrupted move) |
| call timeout after remote success | every cross-canister write carries an idempotency key, as the payment and escrow flows already do (#12, #13) |

## Cross-shard parents

A record's parents may live on other shards. `parents` becomes a list of
`{ shard, record }` references, and **each is checked synchronously** against
the shard that owns it before the reveal is accepted: unknown or revoked parents
are refused, exactly as on one canister, and an unreachable parent shard is a
*retryable refusal*, never an acceptance marked "unverified". Parents are
bounded (32), so the cost is bounded; the index is not consulted for this,
because it is eventually consistent and a revocation it has not yet seen would
let a withdrawn record acquire children. The model covers all four cases.

## Export and billing

Because a tenant lives on one shard, its export (#19) is a paged,
checksummed read of one canister, and its invoice (#14) is computed where its
usage events are. A move is an event on the target, so an invoice period that
spans a move is assembled from both shards' events by the billing job, keyed
by tenant and period — the invoice rules do not change. Platform-wide totals are
index-side aggregates, rebuildable like everything else there.

## Test plan

| Case | Model check |
|---|---|
| hot tenant | a tenant split by collection spreads evenly over three shards; an unrouted collection falls back to the tenant route |
| router stale | one redirect, the write lands on the new shard, nothing lands on the old one |
| shard unavailable | refused outright, other tenants unaffected, index serves with a visible gap, nothing half-applied |
| cross-shard parent | accepted when verified, refused when unknown or revoked, retryable when unreachable |
| duplicate global hash race | all six delivery orders give the same holder and duplicates |
| index rebuild from events | 50 interleavings with duplicate delivery equal a rebuild from logs; gaps refused, redeliveries no-ops |
| shard migration | interrupted after the copy, writes refused as retryable, re-run completes, content hash identical |
| tenant export | paged, every page checksummed, holds moved and new records |

## Acceptance

- **Architecture supports tenant export and billing** — a tenant is shard-local;
  export and invoices are shard-local; a move is an auditable event.
- **Duplicate global hash race has a deterministic result** — earliest
  commitment holds, total order on ties, independent of delivery order.
- **Index can be rebuilt from events** — the index is derived only from
  per-shard sequenced logs and is checked equal to a replay.
- **Shard migration has a rehearsal plan** — above, with the model as its first
  step.

What remains before this is more than a design: the shard and router canisters
themselves, #19's export format, #30's measurements for the thresholds, and a
pocket-ic rehearsal of a real move.
