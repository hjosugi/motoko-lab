---
title: "Design tenant sharding, routing, and global hash index"
labels: ["priority:P1", "area:scale", "type:research", "effort:XL"]
milestone: "M4 Scale and Interop"
---
# Context

A large service should scale by measured operational boundaries rather than one giant canister.

## Scope

- [ ] Define routing key and epoch.
- [ ] Separate authoritative writes from rebuildable indexes.
- [ ] Design shard creation/move protocol.
- [ ] Define global artifact hash uniqueness policy.
- [ ] Model partial failures and stale routes.

## Acceptance criteria

- [ ] Architecture supports tenant export and billing.
- [ ] Duplicate global hash race has deterministic result.
- [ ] Index can be rebuilt from events.
- [ ] Shard migration has rehearsal plan.

## Test plan

- [ ] Hot tenant
- [ ] Router stale
- [ ] Shard unavailable
- [ ] Cross-shard parent

## Dependencies

#019

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
