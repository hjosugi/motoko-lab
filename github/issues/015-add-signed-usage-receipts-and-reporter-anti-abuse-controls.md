---
title: "Add signed usage receipts and reporter anti-abuse controls"
labels: ["priority:P1", "area:security", "area:business", "type:feature", "effort:L"]
milestone: "M3 Payments and Business"
---
# Context

A compromised authorized reporter can exhaust tenant quota or inflate billing.

## Scope

- [ ] Define signed usage receipt schema.
- [ ] Bind tenant, units, category, timestamp, and idempotency key.
- [ ] Add per-reporter scopes and limits.
- [ ] Add clock-skew/replay policy.
- [ ] Expose audit export.

## Acceptance criteria

- [ ] Invalid signature is rejected.
- [ ] Receipt replay returns original event only.
- [ ] Reporter cannot write outside scope.
- [ ] Rate anomaly is observable.

## Test plan

- [ ] Key rotation
- [ ] Offline batch
- [ ] Future timestamp
- [ ] Reporter compromise

## Dependencies

#005, #007

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
