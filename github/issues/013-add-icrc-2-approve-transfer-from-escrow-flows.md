---
title: "Add ICRC-2 approve/transfer-from escrow flows"
labels: ["priority:P1", "area:payments", "type:feature", "effort:XL"]
milestone: "M3 Payments and Business"
---
# Context

Escrowed marketplace/bounty flows need audited allowance and transfer-from handling.

## Scope

- [ ] Model allowance, expiry, fee, created_at_time, and duplicate handling.
- [ ] Fund escrow before accepting work/order.
- [ ] Settle winner/seller and platform fee.
- [ ] Implement refund/cancel path.
- [ ] Isolate ledger calls behind adapter.

## Acceptance criteria

- [ ] No award/grant without funded escrow.
- [ ] Settlement and refund are idempotent.
- [ ] Partial failures remain recoverable.
- [ ] Accounting invariant is tested.

## Test plan

- [ ] Allowance expires
- [ ] Fee changes
- [ ] Insufficient funds
- [ ] Duplicate callback

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
