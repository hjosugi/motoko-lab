---
title: "Complete privacy and data-protection review"
labels: ["priority:P0", "area:privacy", "type:security", "effort:L"]
milestone: "M2 Production Safety"
---
# Context

Immutable public storage can conflict with deletion, confidentiality, and personal-data obligations.

## Scope

- [ ] Classify every field as public, private, hashed, or sealed.
- [ ] Remove direct personal data from on-chain schemas.
- [ ] Define retention and off-chain deletion process.
- [ ] Analyze dictionary attacks on hashes.
- [ ] Create DPIA/legal review checklist.

## Acceptance criteria

- [ ] No raw prompt/email/IP/private source is required on-chain.
- [ ] UI warns before irreversible publication.
- [ ] Export and dispute workflow respect access policy.
- [ ] Terms accurately describe limitations.

## Test plan

- [ ] Low-entropy hash
- [ ] Minor user
- [ ] Court order
- [ ] Cross-border storage

## Dependencies

None

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
