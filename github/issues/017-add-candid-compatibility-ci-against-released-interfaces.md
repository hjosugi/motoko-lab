---
title: "Add Candid compatibility CI against released interfaces"
labels: ["priority:P0", "area:api", "area:test", "type:chore", "effort:M"]
milestone: "M2 Production Safety"
---
# Context

Hand-written Candid files can drift or introduce breaking changes.

## Scope

- [ ] Generate actual Candid from build.
- [ ] Compare generated and committed files.
- [ ] Run compatibility check against latest release tag.
- [ ] Document allowed/deprecated changes.
- [ ] Fail PR on unreviewed break.

## Acceptance criteria

- [ ] Every app has a released baseline `.did`.
- [ ] Breaking test fixture fails.
- [ ] Additive fixture passes.
- [ ] Release process stores interface artifact.

## Test plan

- [ ] Variant tag removal
- [ ] Required field addition
- [ ] Numeric narrowing
- [ ] Method rename

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
