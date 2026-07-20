---
title: "Build monetization experiment and unit-economics dashboard"
labels: ["priority:P1", "area:business", "type:feature", "effort:M"]
milestone: "M3 Payments and Business"
---
# Context

Pricing decisions need retention, conversion, cost, and support data rather than comparable-project hype.

## Scope

- [ ] Define events for activation, proof creation, verification, export, subscription, license GMV.
- [ ] Track cycles/storage/support cost per tenant.
- [ ] Create cohort retention and conversion views.
- [ ] Run at least three pricing experiments.
- [ ] Avoid collecting unnecessary personal data.

## Acceptance criteria

- [ ] Gross margin can be estimated per plan.
- [ ] Experiment has hypothesis and stop rule.
- [ ] Dashboard distinguishes volume, fee, revenue, and profit.
- [ ] Data definitions are versioned.

## Test plan

- [ ] Free abuse
- [ ] Annual plan
- [ ] Storage-heavy tenant
- [ ] Marketplace refunds

## Dependencies

#014, #022, #024

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
