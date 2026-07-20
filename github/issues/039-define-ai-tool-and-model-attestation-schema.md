---
title: "Define AI tool and model attestation schema"
labels: ["priority:P1", "area:ai", "area:provenance", "type:research", "effort:XL"]
milestone: "M4 Scale and Interop"
---
# Context

Self-reported AI use is useful but weak evidence without tool-signed or organization-issued attestations.

## Scope

- [ ] Define provider/model/version/role/prompt-output digest fields.
- [ ] Support local tool and provider signatures.
- [ ] Define privacy-preserving sealed prompts.
- [ ] Specify trust levels and verifier warnings.
- [ ] Create sample attestations and threat model.

## Acceptance criteria

- [ ] Verifier distinguishes self-asserted, tool-signed, and organization-reviewed evidence.
- [ ] Attestation cannot be replayed for another artifact.
- [ ] Private prompt is not required publicly.
- [ ] Key rotation and revocation are covered.

## Test plan

- [ ] Provider unavailable
- [ ] Model alias changes
- [ ] Local model
- [ ] Prompt injection into metadata

## Dependencies

#005, #011

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
