---
title: "Add enhanced persistence migration-chain examples"
labels: ["priority:P0", "area:upgrade", "area:docs", "type:feature", "effort:L"]
milestone: "M2 Production Safety"
---
# Context

Production users need concrete additive, eager, lazy, and multi-step migration examples for current Motoko.

## Scope

- [ ] Create V1/V2/V3 fixture canisters.
- [ ] Demonstrate enhanced migration chain supported by current compiler.
- [ ] Include stable compatibility commands.
- [ ] Measure data-size behavior.
- [ ] Document downgrade limits.

## Acceptance criteria

- [ ] Examples compile with current compiler.
- [ ] Fixture data survives every step.
- [ ] Intentional incompatible change fails in CI.
- [ ] Docs include exact version and commands.

## Test plan

- [ ] Empty state
- [ ] Large map
- [ ] Revoked variants
- [ ] Interrupted rollout

## Dependencies

#001, #002

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
