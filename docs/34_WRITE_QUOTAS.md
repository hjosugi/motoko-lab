# Write quotas and abuse economics

Every `commit` and `reveal` in the creator proof registry is free. That is
deliberate — provenance should not be pay-to-play — but it also means a
principal with a script can fill the canister: commitments are cheap, records
are permanent, and storage is the operator's cycles. Issue #22 adds the abuse
economics: a free allowance per principal, caps on record size and total
storage, counters that say what was refused and why, and an operator-owned
policy that can change without rewriting a single record.

## The policy

`Quota.Policy` (`backend/src/Quota.mo`) and its defaults:

| Field | Default | Meaning |
|---|---:|---|
| `freeWritesPerWindow` | 100 | `commit` + `reveal` **attempts** per principal per window |
| `windowSeconds` | 3,600 | the window length |
| `maxRecordBytes` | 65,536 | encoded size of one record (`RecordDigest.encode`) |
| `maxStorageBytes` | 10,485,760 | total encoded record bytes one principal may hold |
| `maxOpenCommitments` | 50 | open, un-revealed commitments one principal may hold |

Attempts are counted, not successes: a script cannot make the canister do
unbounded work by having every call refused. `cancelCommitment` and
`revokeRecord` are free — they reduce state — and closing a commitment frees
its open-commitment slot. The window rolls on the next call after it ends; a
quiet principal starts a fresh window. Storage is **not** per-window: bytes
already on chain stay counted.

The checks run before anything is written, in a fixed order: the record's own
size, then the open-commitment count, then the window allowance, then the
storage total. The first refusal is returned as `#conflict` with a stable
prefix:

```
write rejected: writeQuota limit=4 used=4 retryAt=1625861830000000000
write rejected: recordTooLarge limit=1200 requested=1740
write rejected: storageQuota limit=2000 used=1740 requested=1740
write rejected: tooManyOpen limit=2 used=2
```

The `Error` variant is unchanged: adding a tag to a shared result variant is
the one Candid change this repository treats as breaking, so the reason is in
the message and in the metrics rather than in a new variant.

## Transparency and metrics

```candid
getWritePolicy : () -> (QuotaPolicy) query;
principalUsage : (principal) -> (QuotaUsage) query;
writeMetrics : () -> (WriteMetrics) query;
setWritePolicy : (QuotaPolicy) -> (QuotaPolicyResult);          // controller
setPrincipalAllowance : (principal, opt QuotaAllowance) -> (AllowanceResult); // controller
```

- `getWritePolicy` is the limit in force.
- `principalUsage` returns the caller-visible counters with the window rolled
  to now: `writes`, `windowStart`, `storageBytes`, `openCommitments`, and the
  live `extraWrites` / `extraStorageBytes`.
- `writeMetrics` returns the policy, the allowed and refused totals, and a
  per-reason rejection count. A rise in `writeQuota` or `tooManyOpen` is the
  operator's signal that a principal is probing the free allowance.
- Both setters are controller-only and in the privileged-action inventory
  (`docs/26_GOVERNANCE_DECISION_RECORD.md`).

## Allowances and the paid path

An allowance is extra writes and storage for one principal, with a mandatory
`reference` and an expiry:

```candid
type QuotaAllowance = record {
  extraWrites : nat;
  extraStorageBytes : nat;
  reference : text;   // where the settlement happened
  expiresAt : nat;
};
```

The registry has no price of its own. The **verified** settlement paths in this
kit are the paid applications: the license marketplace's ICRC-1 verification
(#12), the bounty board's ICRC-2 escrow (#13), and the metering app's plans,
invoices and verified invoice payments (#14). An operator who has verified a
payment there records its reference here (`"invoice INV-42"`,
`"icrc1:ryjl3-tyaaa-aaaaa-aaaba-cai:123456"`); an allowance without a
reference is refused, and the allowance is visible in `principalUsage` and in
the metrics, so the grant is auditable. A paid tier with an on-chain purchase
flow inside app 01 is deliberately absent: the registry has no business model
in this kit, and adding a second payment adapter would duplicate the verified
ones.

## Changing plans without rewriting history

`setWritePolicy` replaces the limits for **new** writes. It does not touch
records, ids, timestamps, the certified tree, or any existing counter's
history; a principal who is over the new limit is simply refused until their
window rolls or they receive an allowance. The replica suite asserts that an
existing record is byte-identical after a policy change, and that the policy,
the counters and the allowance all survive an upgrade.

## What is counted where

- Storage accounting is the **encoded** record size, the same bytes the
  certified digest covers, so the number the quota uses is the number the
  canister actually stores.
- Restore (`#19`) rebuilds the accounting: imported open commitments occupy
  slots and imported records add storage bytes, so a restored canister enforces
  the same limits as the source.
- Counters are per principal per canister. The sharding design (#23) routes a
  tenant to one shard, so a tenant's writes are metered on one canister; a
  principal spread across shards would be metered per shard, which is the
  documented boundary of a per-canister quota.

## Evidence

- `apps/01_creator_proof_registry/test/replica.test.mjs`, "write quotas"
  section: 35 checks covering the policy read/write, controller gate, window
  and open-commitment refusals, attempts vs successes, allowance grant/expiry,
  window roll (writes reset, storage does not), record-size and storage caps,
  per-reason metrics, no history rewrite, and upgrade persistence. The app's
  suite is 275 checks.
- The default policy leaves the state-machine models untouched: across seeds
  1–6 the busiest principal makes 52 write attempts and holds at most 6 open
  commitments, against limits of 100 and 50.
- `mops test` covers the pure quota arithmetic in `Quota.mo` through the
  replica suite; Candid drift and compatibility pass, and the privileged-action
  inventory is 42/42.
