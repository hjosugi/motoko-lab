# Cost and Capacity Model

## Inputs

```text
active_creators
proofs_per_creator_month
bytes_per_proof
verification_queries_per_proof
updates_per_proof
index_amplification
archive_replication
cycle_cost_per_update
cycle_cost_per_query
support_minutes_per_customer
```

## Derived metrics

```text
monthly_records = active_creators * proofs_per_creator_month
monthly_storage = monthly_records * bytes_per_proof * index_amplification
monthly_verifications = monthly_records * verification_queries_per_proof
unit_cost_creator = cycles + storage + egress + support + payment + AI
```

## Measurement plan

- 1k、10k、100k record fixture
- p50/p95 update/query
- cycles before/after workload
- heap/stable memory growth
- upgrade duration
- export duration
- index rebuild throughput

## Scale gates

- single canister until measured limit is approached
- shard before operational window becomes unsafe
- archive immutable history before index becomes hot
- batch proof creation for high-volume studios

## Pricing guardrail

paid plan gross margin targetを先に置きます。storage-heavy private vaultをunlimited planに含めません。
