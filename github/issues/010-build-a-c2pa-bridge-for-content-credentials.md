---
title: "Build a C2PA bridge for content credentials"
labels: ["priority:P1", "area:interop", "area:provenance", "type:research", "effort:XL"]
milestone: "M4 Scale and Interop"
---
# Context

Creators need provenance evidence embedded in common media workflows, not only a registry URL.

## Scope

- [ ] Map registry record fields to C2PA assertions.
- [ ] Define bidirectional references.
- [ ] Prototype signing and verification for one image format.
- [ ] Document trust and revocation semantics.
- [ ] Check current C2PA specification before implementation.

## Acceptance criteria

- [ ] A sample asset carries a credential referencing an ICP proof.
- [ ] Verifier checks both credential signature and registry status.
- [ ] Broken link and revoked record are clearly reported.

## Test plan

- [ ] Credential valid/record revoked
- [ ] Asset modified
- [ ] Offline verification

## Dependencies

#005, #006

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
