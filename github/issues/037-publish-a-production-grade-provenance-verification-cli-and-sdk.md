---
title: "Publish a production-grade provenance verification CLI and SDK"
labels: ["priority:P1", "area:developer-experience", "area:provenance", "type:feature", "effort:XL"]
milestone: "M4 Scale and Interop"
---
# Context

Independent verification must not depend on the product website.

## Scope

- [ ] Replace educational canonicalizer with standards-compliant implementation.
- [ ] Fetch record/certificate from configurable gateway.
- [ ] Verify artifact, manifest, commitment, status, credentials, and C2PA links.
- [ ] Emit JSON and human-readable report.
- [ ] Publish TypeScript package and signed release.

## Acceptance criteria

- [ ] CLI verifies offline inputs and online record.
- [ ] Tampered gateway response fails when certification is enabled.
- [ ] Exit codes are documented.
- [ ] Test vectors run in release CI.

## Test plan

- [ ] Offline bundle
- [ ] Revoked record
- [ ] Unknown issuer
- [ ] Large artifact streaming

## Dependencies

#004, #005, #006, #010, #011

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
