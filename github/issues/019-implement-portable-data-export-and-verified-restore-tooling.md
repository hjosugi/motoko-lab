---
title: "Implement portable data export and verified restore tooling"
labels: ["priority:P0", "area:operations", "type:feature", "effort:XL"]
milestone: "M2 Production Safety"
---
# Context

Blockchain persistence does not replace portable backup, audit, or migration capability.

## Scope

- [ ] Define versioned export format.
- [ ] Stream bounded pages with checksums.
- [ ] Include module/Candid/schema metadata.
- [ ] Build restore into fresh canister or migration tool.
- [ ] Test index rebuild.

## Acceptance criteria

- [ ] Record counts and content hashes match after restore.
- [ ] Export resumes after interruption.
- [ ] Sensitive pointers can be filtered by policy.
- [ ] Restore is rehearsed in CI/staging.

## Test plan

- [ ] Large dataset
- [ ] Revoked records
- [ ] Multiple shards
- [ ] Corrupted page

## Dependencies

#017

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
