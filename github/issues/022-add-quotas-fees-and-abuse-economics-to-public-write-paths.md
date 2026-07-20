---
title: "Add quotas, fees, and abuse economics to public write paths"
labels: ["priority:P0", "area:security", "area:business", "type:feature", "effort:L"]
milestone: "M3 Payments and Business"
---
# Context

Authenticated principals can still spam records and consume storage/cycles.

## Scope

- [ ] Measure unit cost per write/byte.
- [ ] Define free quota and paid batch limits.
- [ ] Add per-principal and per-tenant counters.
- [ ] Implement storage-size caps and rejection metrics.
- [ ] Design bond for disputes if needed.

## Acceptance criteria

- [ ] A single principal cannot create unbounded free state.
- [ ] Limits are transparent and testable.
- [ ] Paid path uses verified settlement.
- [ ] Operators can change plans without rewriting history.

## Test plan

- [ ] Burst traffic
- [ ] Many principals
- [ ] Large parent arrays
- [ ] Plan downgrade

## Dependencies

#012, #025

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
