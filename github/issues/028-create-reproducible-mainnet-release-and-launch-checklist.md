---
title: "Create reproducible mainnet release and launch checklist"
labels: ["priority:P0", "area:release", "type:chore", "effort:L"]
milestone: "M3 Payments and Business"
---
# Context

A mainnet deploy must be reproducible, reviewed, monitored, and reversible through forward fixes.

## Scope

- [ ] Pin dependencies/toolchain/recipe.
- [ ] Build and record Wasm hash.
- [ ] Review controllers and cycles.
- [ ] Run staging upgrade and smoke tests.
- [ ] Publish canister IDs, Candid, module hash, policy/version.

## Acceptance criteria

- [ ] Two operators reproduce the same artifact hash.
- [ ] Mainnet smoke passes.
- [ ] Monitoring and incident contacts are active.
- [ ] No test identity controls production.

## Test plan

- [ ] Fresh machine build
- [ ] Canary deploy
- [ ] Emergency read-only mode

## Dependencies

#001, #017, #021, #024

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
