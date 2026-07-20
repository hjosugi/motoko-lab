---
title: "Implement correction, counterclaim, and dispute workflow"
labels: ["priority:P1", "area:governance", "area:provenance", "type:feature", "effort:XL"]
milestone: "M4 Scale and Interop"
---
# Context

Revocation alone does not represent third-party counterclaims or adjudication outcomes.

## Scope

- [ ] Define claim, counterclaim, evidence reference, response, and resolution states.
- [ ] Keep original records immutable.
- [ ] Separate technical status from policy/legal outcome.
- [ ] Add abuse controls and privacy rules.
- [ ] Create portable dispute export.

## Acceptance criteria

- [ ] A third party can submit a bonded or rate-limited counterclaim.
- [ ] Owner can respond.
- [ ] Verifier displays unresolved and resolved status without declaring legal truth.
- [ ] All state transitions are auditable.

## Test plan

- [ ] False report spam
- [ ] Private evidence pointer
- [ ] Appeal
- [ ] Conflicting authorities

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
