---
title: "Build W3C Verifiable Credential issuer and verifier integration"
labels: ["priority:P1", "area:identity", "area:interop", "type:feature", "effort:XL"]
milestone: "M4 Scale and Interop"
---
# Context

Principal ownership alone does not establish organization membership or reviewer authority.

## Scope

- [ ] Define credential types for membership, delegated authority, and review.
- [ ] Use VC Data Model 2.0-compatible representation.
- [ ] Implement issuer allowlist/policy.
- [ ] Check credential status/revocation.
- [ ] Return nuanced verification report.

## Acceptance criteria

- [ ] Organization credential can be linked and verified.
- [ ] Expired/revoked credential is rejected.
- [ ] Unknown issuer produces a warning, not false success.
- [ ] Personal data minimization is reviewed.

## Test plan

- [ ] Expired VC
- [ ] Revoked VC
- [ ] Issuer rotation
- [ ] Selective disclosure research

## Dependencies

#007

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
