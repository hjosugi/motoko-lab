---
title: "Design and implement creator key rotation and scoped delegation"
labels: ["priority:P0", "area:identity", "area:provenance", "type:feature", "effort:XL"]
milestone: "M2 Production Safety"
---
# Context

A single principal creates a permanent key-loss and organization offboarding risk.

## Scope

- [ ] Define root identity, signing keys, delegation scopes, expiry, and revocation.
- [ ] Add collection/project-scoped delegation.
- [ ] Create key rotation records without rewriting old proofs.
- [ ] Support recovery policy references.
- [ ] Define verifier trust output.

## Acceptance criteria

- [ ] Old records remain attributable after rotation.
- [ ] Revoked delegate cannot create new records.
- [ ] Delegation scope and expiry are enforced.
- [ ] Recovery cannot silently transfer identity.

## Test plan

- [ ] Expired delegation
- [ ] Compromised key
- [ ] Organization member removal
- [ ] Concurrent rotations

## Dependencies

#005

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
