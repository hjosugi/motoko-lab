---
title: "Add audited on-chain SHA-256 commitment verification"
labels: ["priority:P0", "area:crypto", "area:provenance", "type:security", "effort:L"]
milestone: "M1 Protocol Core"
---
# Context

The registry currently stores commitment and reveal data but relies on an external verifier to recompute SHA-256.

## Scope

- [ ] Select an actively maintained Motoko crypto package or implement a reviewed minimal SHA-256 module.
- [ ] Implement exact v1 domain-separated preimage layout.
- [ ] Reject reveal when recomputed digest differs.
- [ ] Add algorithm/version type for future agility.
- [ ] Document cycle and instruction cost.

## Acceptance criteria

- [ ] Canister rejects wrong principal, manifest hash, or salt.
- [ ] Protocol vectors match Node verifier.
- [ ] Implementation passes known SHA-256 vectors.
- [ ] Dependency license and maintenance status are documented.

## Test plan

- [ ] NIST vectors
- [ ] Cross-language test vectors
- [ ] Maximum salt size
- [ ] Performance benchmark

## Dependencies

#001

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
