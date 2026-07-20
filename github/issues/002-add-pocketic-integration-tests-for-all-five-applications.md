---
title: "Add PocketIC integration tests for all five applications"
labels: ["priority:P0", "area:test", "type:feature", "effort:XL"]
milestone: "M2 Production Safety"
---
# Context

Pure validation tests do not exercise caller identities, upgrades, inter-canister behavior, or state persistence.

## Scope

- [ ] Create PocketIC test harness.
- [ ] Test anonymous, owner, non-owner, controller, and reporter identities.
- [ ] Cover primary lifecycle and conflict paths.
- [ ] Run an upgrade with retained state.
- [ ] Publish deterministic fixtures.

## Acceptance criteria

- [ ] Each public update method has a happy-path and authorization test.
- [ ] At least one upgrade test per app.
- [ ] Duplicate/idempotency behavior is verified.
- [ ] Tests run in CI without mainnet access.

## Test plan

- [ ] Fresh replica per suite
- [ ] Randomized caller order
- [ ] Upgrade old fixture to new Wasm

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
