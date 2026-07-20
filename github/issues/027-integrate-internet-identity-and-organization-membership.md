---
title: "Integrate Internet Identity and organization membership"
labels: ["priority:P1", "area:identity", "area:frontend", "type:feature", "effort:L"]
milestone: "M3 Payments and Business"
---
# Context

Users need usable authentication and organizations need role management beyond raw principal display.

## Scope

- [ ] Add Internet Identity login.
- [ ] Map frontend session to caller principal.
- [ ] Create organization/member/role model.
- [ ] Support invite, removal, and delegated proof rights.
- [ ] Document recovery and privacy.

## Acceptance criteria

- [ ] No frontend-supplied principal is trusted.
- [ ] Removed member cannot write.
- [ ] Organization audit log is exportable.
- [ ] Personal and organization records remain distinguishable.

## Test plan

- [ ] Multiple devices
- [ ] Lost anchor
- [ ] Member offboarding
- [ ] Role downgrade

## Dependencies

#007, #026

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
