---
title: "Prepare governance and SNS-readiness decision record"
labels: ["priority:P2", "area:governance", "type:research", "effort:L"]
milestone: "M4 Scale and Interop"
---
# Context

Moving control to a DAO too early can freeze unsafe policy; moving too late leaves unilateral admin risk.

## Scope

- [ ] List current privileged actions.
- [ ] Define multisig phase and transparency requirements.
- [ ] Define which parameters may be governed.
- [ ] Model emergency response and upgrade veto.
- [ ] Evaluate SNS only after product and treasury maturity.

## Acceptance criteria

- [ ] Controller policy is explicit.
- [ ] Module hash/release approvals are auditable.
- [ ] Emergency action has bounded authority and review.
- [ ] SNS go/no-go criteria are documented.

## Test plan

- [ ] Key compromise
- [ ] Malicious proposal
- [ ] Slow emergency vote
- [ ] Treasury conflict

## Dependencies

#021, #028, #035

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
