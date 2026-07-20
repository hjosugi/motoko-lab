---
title: "Add property-based state-machine tests"
labels: ["priority:P1", "area:test", "type:feature", "effort:XL"]
milestone: "M2 Production Safety"
---
# Context

Lifecycle bugs often appear only after unusual command sequences.

## Scope

- [ ] Build pure model for registry, marketplace, bounty, and metering.
- [ ] Generate valid/invalid command sequences.
- [ ] Compare model and canister observations.
- [ ] Shrink failing sequences.
- [ ] Run deterministic seeds in CI.

## Acceptance criteria

- [ ] Revoked records never reactivate.
- [ ] One receipt creates at most one grant.
- [ ] Closed bounty cannot be re-awarded.
- [ ] Usage never exceeds quota.

## Test plan

- [ ] Long random sequences
- [ ] Boundary Nat values
- [ ] Upgrade between commands

## Dependencies

#002

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
