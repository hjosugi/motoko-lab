---
title: "Add subscription billing and invoice entities"
labels: ["priority:P1", "area:payments", "area:business", "type:feature", "effort:L"]
milestone: "M3 Payments and Business"
---
# Context

Usage metering has plans and quota but no immutable invoice or settlement model.

## Scope

- [ ] Define billing period close and invoice snapshot.
- [ ] Prevent late usage mutation after close.
- [ ] Link payment receipt and status.
- [ ] Support credit/adjustment records without deleting invoice.
- [ ] Export customer-readable invoice JSON.

## Acceptance criteria

- [ ] Same period closes once.
- [ ] Invoice amount is reproducible from events and plan.
- [ ] Payment applies exactly once.
- [ ] Adjustment history is immutable.

## Test plan

- [ ] Late event
- [ ] Plan change mid-period
- [ ] Refund/credit
- [ ] Currency change

## Dependencies

#012

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
