---
title: "Benchmark storage, cycles, latency, and upgrade behavior"
labels: ["priority:P1", "area:performance", "type:research", "effort:L"]
milestone: "M4 Scale and Interop"
---
# Context

Scale decisions and pricing need measured cost instead of assumptions.

## Scope

- [ ] Generate 1k/10k/100k record fixtures.
- [ ] Measure update/query cycles and p50/p95 latency.
- [ ] Measure memory and archive growth.
- [ ] Measure upgrade and export time.
- [ ] Publish reproducible benchmark script.

## Acceptance criteria

- [ ] Results include exact versions and hardware/environment.
- [ ] Regression thresholds are set in CI.
- [ ] Cost per paid customer can be estimated.
- [ ] Sharding trigger is evidence-based.

## Test plan

- [ ] Long text bounds
- [ ] Many parents
- [ ] Revoked ratio
- [ ] Index rebuild

## Dependencies

#001, #019, #024

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
