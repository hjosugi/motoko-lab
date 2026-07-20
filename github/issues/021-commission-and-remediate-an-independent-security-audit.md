---
title: "Commission and remediate an independent security audit"
labels: ["priority:P0", "area:security", "type:security", "effort:XL"]
milestone: "M2 Production Safety"
---
# Context

The reference implementation must not handle funds or high-value evidence without independent review.

## Scope

- [ ] Freeze audit commit and threat model.
- [ ] Include Motoko source, Candid, migrations, crypto, payments, controllers, and client verifier.
- [ ] Track findings by severity.
- [ ] Publish remediation evidence where safe.
- [ ] Run re-test.

## Acceptance criteria

- [ ] No unresolved critical/high finding at production launch.
- [ ] All accepted risks have owner and expiry.
- [ ] Audit scope and commit hashes are public or customer-accessible.

## Test plan

- [ ] Upgrade path
- [ ] Dependency supply chain
- [ ] Gateway/client verification

## Dependencies

#003, #006, #012, #017

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
