# Blueprint for a Large Motoko Service

## North-star architecture

“最大”をsingle canisterのdata sizeで定義しません。reliable tenants、verified events、developer ecosystem、economic sustainabilityで定義します。

## Canister roles

- governance/config canister
- tenant router
- write registry shards
- read index shards
- archive shards
- payment adapters
- credential adapters
- notification/outcall workers
- asset frontend

## Routing contract

routerは`tenant -> shard principal + epoch`を返します。clientはepochをrequestに含め、stale routeならretryします。

## Event contract

各authoritative writeは次を持ちます。

- global/tenant sequence
- event type/version
- actor principal
- request id
- timestamp
- payload hash
- previous event hash optional

index/archiveはeventからrebuild可能にします。

## Multi-canister failure

- call timeout after remote success
- duplicate delivery
- partial index update
- shard unavailable
- router stale
- payment settled but license grant pending

全workflowをstate machine + idempotencyで扱います。

## Deployment

- canary shard
- module hash allowlist
- per-shard upgrade status
- read-only switch
- bounded parallel rollout
- automatic smoke test
- forward-fix plan

## Developer platform

largest serviceを目指すなら、end-user appだけでなくAPI/SDKを作ります。

- Candid interface versioning
- TypeScript/Rust/Motoko client
- test vectors
- webhook/outbox
- sandbox environment
- usage metering
- status page and changelog

## Governance maturity

1. single team + hardware keys
2. multisig/change review
3. transparent release/module hash
4. community advisory process
5. SNS/DAO only when upgrades and treasury rules are mature
