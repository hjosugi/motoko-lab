---
title: "Add content availability adapters and integrity monitoring"
labels: ["priority:P1", "area:storage", "type:feature", "effort:XL"]
milestone: "M4 Scale and Interop"
---
# Context

A valid hash is less useful when the referenced artifact or manifest disappears.

## Scope

- [ ] Support ICP asset canister and customer-controlled URI adapters.
- [ ] Optionally support content-addressed mirrors.
- [ ] Periodically verify availability and digest.
- [ ] Respect private/encrypted evidence policy.
- [ ] Expose availability separately from authorship evidence.

## Acceptance criteria

- [ ] Verifier reports available/missing/mismatched without changing historical proof.
- [ ] Mirror policy is opt-in.
- [ ] Large files are streamed.
- [ ] Storage costs are metered.

## Test plan

- [ ] URI takeover
- [ ] Encrypted object
- [ ] Deleted public content
- [ ] Mirror mismatch

## Dependencies

#019, #020, #024

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
