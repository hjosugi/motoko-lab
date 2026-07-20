---
title: "Add observability, cycle alerts, and service-level indicators"
labels: ["priority:P0", "area:operations", "type:feature", "effort:L"]
milestone: "M2 Production Safety"
---
# Context

Production operation requires measurable cycles, errors, latency, growth, and pending workflows.

## Scope

- [ ] Define metrics schema and collection path.
- [ ] Track module hash, cycles, memory, counts, error/reject rates, pending age, index lag.
- [ ] Set warning/critical thresholds.
- [ ] Create dashboard and alert routing.
- [ ] Document telemetry privacy.

## Acceptance criteria

- [ ] Cycle runway alert fires in test.
- [ ] Pending payment/index lag are visible.
- [ ] Deployment annotation is recorded.
- [ ] Runbook links from every critical alert.

## Test plan

- [ ] Metrics backend unavailable
- [ ] Alert storm
- [ ] False positive
- [ ] Multi-shard aggregation

## Dependencies

#001

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
