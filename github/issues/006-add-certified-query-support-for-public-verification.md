---
title: "Add certified query support for public verification"
labels: ["priority:P0", "area:security", "area:provenance", "type:feature", "effort:XL"]
milestone: "M2 Production Safety"
---
# Context

Uncertified query responses may be altered by an untrusted gateway and should not be the only verification path.

## Scope

- [ ] Design certified map/root for record lookup.
- [ ] Return certificate/witness or use supported certified asset/data pattern.
- [ ] Implement browser/client verification.
- [ ] Document fallback to update calls.
- [ ] Measure update cost of certification.

## Acceptance criteria

- [ ] Client detects modified record/status response.
- [ ] Active and revoked records are covered.
- [ ] Certificate verification works through standard gateways.
- [ ] Threat model and API docs are updated.

## Test plan

- [ ] Valid witness
- [ ] Corrupted witness
- [ ] Stale root
- [ ] Archive record

## Dependencies

#001, #003

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
