---
title: "Implement an ICRC-1 payment verification adapter"
labels: ["priority:P0", "area:payments", "type:feature", "effort:XL"]
milestone: "M3 Payments and Business"
---
# Context

License and bounty apps currently rely on manual payment confirmation.

## Scope

- [ ] Define a ledger-agnostic adapter interface.
- [ ] Fetch/verify transfer block or supported transaction proof.
- [ ] Validate from/to/amount/fee/memo/time.
- [ ] Deduplicate ledger+block.
- [ ] Use pending/verified/rejected state machine.

## Acceptance criteria

- [ ] A forged receipt cannot create a grant.
- [ ] A valid payment is accepted exactly once.
- [ ] Ledger reject/timeout is retry-safe.
- [ ] Token decimals and fees are explicit.

## Test plan

- [ ] Wrong recipient
- [ ] Underpayment
- [ ] Duplicate block
- [ ] Timeout after success

## Dependencies

#001, #002

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
