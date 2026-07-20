---
title: "Build a production creator and verifier frontend"
labels: ["priority:P1", "area:frontend", "type:feature", "effort:XL"]
milestone: "M3 Payments and Business"
---
# Context

Candid UI is not an acceptable creator workflow or public verifier.

## Scope

- [ ] Implement local hashing before upload.
- [ ] Explain irreversible/public fields.
- [ ] Support commit then reveal recovery.
- [ ] Display verification report and warnings.
- [ ] Add accessibility and mobile flow.

## Acceptance criteria

- [ ] First proof can be created in under five minutes.
- [ ] Wrong artifact visibly fails verification.
- [ ] Revoked/disputed state is prominent.
- [ ] No raw private evidence is sent by default.

## Test plan

- [ ] Interrupted reveal
- [ ] Large file
- [ ] Offline hash
- [ ] Gateway tampering

## Dependencies

#003, #004, #006

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
