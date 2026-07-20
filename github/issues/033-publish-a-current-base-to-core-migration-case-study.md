---
title: "Publish a current base-to-core migration case study"
labels: ["priority:P1", "area:core", "area:docs", "type:docs", "effort:L"]
milestone: "M5 Upstream Maintainer"
---
# Context

Many existing Motoko projects still use base and old collection/persistence patterns.

## Scope

- [ ] Migrate a nontrivial sample to core.
- [ ] Compare API, stable data, performance, and upgrade safety.
- [ ] Document coexistence phase.
- [ ] Create before/after tests.
- [ ] Offer findings upstream.

## Acceptance criteria

- [ ] Sample compiles before and after.
- [ ] Upgrade path preserves fixture data.
- [ ] Deprecated APIs are removed or justified.
- [ ] Case study names exact versions.

## Test plan

- [ ] HashMap to ordered Map
- [ ] Iter API changes
- [ ] Cycles API changes

## Dependencies

#001, #016

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
