# Migration chain: V1 → V2 → V3 with enhanced multi-migration

Issue #16. This is a fixture canister in three versions, built with the pinned
compiler's **enhanced multi-migration** (`moc --enhanced-migration <dir>`) and
rehearsed on a real replica, together with the data it has to carry through
every step.

Versions: **moc 1.11.1**, **core 2.6.0**, **pocket-ic 14.0.0**,
enhanced orthogonal persistence (the default for `persistent actor`). The
enhanced multi-migration docs and changelog were checked on 2026-09-25. The
flag has existed since moc 1.5. moc 1.11.0 allowed effectful transient `let`s
under it, which is what `upgradeInstructions` below relies on. Features
added after 1.11.1, such as `--stable-baseline` in 1.12.0, are not used.

## The chain

Stable variables have **no initializers**. Their values come from the files in
`migrations/`, applied in file-name order, and from nothing else. Version N is
the actor `src/VN.mo` compiled over the first N migrations, which is what the
repository would have held when N shipped.

| # | Migration | Kind | What it does |
| --- | --- | --- | --- |
| 1 | `20260901_000000_Init.mo` | init | `records` (a `Map`), `nextId`, `schemaVersion = 1` |
| 2 | `20260915_000000_RevocationTime.mo` | **eager** | rewrites every record: `#revoked : Text` becomes `#revoked : { reason; at : ?Nat }`, and derives a `revokedCount` counter from the data |
| 3 | `20261001_000000_LicenseLazy.mo` | **lazy** | adds an empty `recordsV3` map and touches no record. V3 converts a record the first time it writes it, or in bounded batches via `drainLegacy` |

Each migration also asserts and advances `schemaVersion`, and none of them
shares types with the actor. A migration is history, so it freezes the types
it reads and writes in its own file. If it imported a shared `Types` module,
a later edit to that module would change what the migration means without
anyone touching the migration.

Two decisions about the data:

- **A revocation from before V2 has no known time**, so it becomes
  `at = null`. It does not become `?0`, and it does not get the upgrade time.
  Inventing a timestamp would put a false statement into a provenance record.
- **A record from before V3 has no license**, so it becomes `license = null`,
  not a default. A license nobody granted is not one to invent.

## Commands

```bash
cd labs/migration-chain
mops install

# Version N = src/VN.mo over the first N migrations (the test stages them).
moc $(mops sources) --enhanced-migration <dir-with-first-N-migrations> \
    src/V3.mo -c -o V3.wasm --stable-types      # also writes V3.most
moc $(mops sources) --enhanced-migration <dir> src/V3.mo --idl -o V3.did

# Stable compatibility between two signatures (exit 0 = compatible)
moc --stable-compatible V2.most V3.most

# The whole rehearsal: compile, gates, and the replica run
node tools/pocket-ic/setup.mjs
node labs/migration-chain/test/migration-chain.test.mjs
```

`.most` files are generated rather than committed. The type names in them
carry hashes derived from absolute source paths, so a committed snapshot would
differ on every other machine. The test compares them semantically with
`moc --stable-compatible` instead.

## What the rehearsal proves

`test/migration-chain.test.mjs` runs 40 checks, and runs in the Replica
workflow. Every "survived" below means that every sampled record (both ends,
the middle, revoked ones, and a fixed spread) equals what the fixture rules in
`src/Fixture.mo` say it must be at that schema version. Every seventh seeded
record is revoked, so revoked variants cross every step.

| Test plan | Result |
| --- | --- |
| Empty state | V1 → V2 → V3 with no records. A fresh V3 install runs the whole chain. |
| Large map | 30,001 records through V1 → V2 → V3: counts, ids, the derived revoked counter, and every sampled record. Draining the lazy map in 12,000-record batches loses nothing. |
| Revoked variants | V1's `#revoked : Text` becomes V2's `{reason; at = null}` and is read unchanged under V3. A record revoked under V1 cannot be revoked again under V3. |
| Interrupted rollout | V2 with revoked records is upgraded to a V3 whose migration 3 traps (`fixtures/trapping-migration/`). The upgrade is rolled back and V2 keeps serving the untouched state and accepting writes. The fixed V3 then applies migration 3, because a migration is recorded only when the upgrade that ran it commits. |
| Fast-forward | A canister left on V1 upgrades straight to V3, applies migrations 2 and 3 in order, and ends in exactly the state of one that took every step. |
| Idempotency | Redeploying V2 over V2 applies nothing. It costs 36,927 instructions against 29,870,466 for the migration it skips. |

### Data size

`upgradeInstructions` is `Prim.performanceCounter(0)`, read by a transient
`let` when the actor body runs. The body runs after the pending migrations, so
the value is what the upgrade message spent up to that point. Measured on
pocket-ic 14.0.0:

| Records | Eager step (V1 → V2), instructions | Lazy step (V2 → V3), instructions | Heap after V3 |
| ---: | ---: | ---: | ---: |
| 0 | 42,092 | 40,868 | 5.3 MB |
| 1,000 | 1,029,357 | 40,884 | 6.2 MB |
| 10,000 | 9,983,954 | 40,884 | 14.9 MB |
| 30,001 | 29,870,466 | 40,916 | 36.3 MB |

The eager step costs about 1,000 instructions per record. That is linear, and
the test asserts that it grows. The lazy step is flat, and the test asserts
that too. An upgrade has a fixed instruction budget, and one that exceeds it
does not happen at all. So once the data is large, the only safe choice is an
upgrade whose cost does not depend on the data. Draining is then ordinary
bounded work spread across messages.

## The gates, and proof that they bite

- **Compile time (the chain check).** The test derives an incompatible V3: the
  legacy record type gains a required field that no migration ever produced.
  The actor body still type-checks, so the only thing that can reject it is
  the chain check. moc rejects it with **M0170** (*the new type of stable
  variable `records` is not compatible with version
  `20260915_000000_RevocationTime`*). The test asserts that exact code, so a
  plain type error would not count as the gate working.
- **Stable signatures.** `--stable-compatible` passes V1→V2, V2→V3 and V1→V3.
  It fails V3→V2 and V2→V1 with **M0169** (*stable variable … cannot be
  implicitly discarded*).
- **Replica.** Upgrading V3 back to V2 or to V1 is refused with `RTS error:
  Memory-incompatible program upgrade`, and V3 and its data are still there
  afterwards.

## Downgrade limits

There is no downgrade. The table above shows what refuses each attempt, and
the reason is structural rather than a missing feature:

- Each migration can consume fields. Migration 2 replaced V1's record shape,
  so the V1 shape no longer exists anywhere in the state. An older build would
  need a reverse migration that nobody wrote.
- The canister records which migrations it has applied. An older build does
  not know the newer migrations, and the runtime will not guess.
- A lazy migration keeps the old map, but only for records not yet converted.
  A V2 build could not see records written or converted under V3.

So the recovery path after a bad release is **forward**. The
interrupted-rollout rehearsal is the case where the bad release never
committed, and nothing needs repairing. If a bad migration did commit, ship a
new migration that repairs the data (docs/24_UPGRADE_MIGRATION_STRATEGY.md,
"Emergency"). Before a risky upgrade, take a snapshot or an export
(#19, #25). The chain cannot give you rollback, and a snapshot can.

## Files

| Path | What |
| --- | --- |
| `migrations/` | the chain, one file per step, applied in name order |
| `src/V1.mo`, `src/V2.mo`, `src/V3.mo` | the actor at each version |
| `src/Fixture.mo` | deterministic fixture data (no stable types) |
| `fixtures/trapping-migration/` | a broken migration 3 with the real one's file name, for the rollout rehearsal |
| `test/migration-chain.test.mjs` | compile, gates, replica rehearsal and measurements |
