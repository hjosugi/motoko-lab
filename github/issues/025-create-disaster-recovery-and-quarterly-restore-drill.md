---
title: "Create disaster recovery and quarterly restore drill"
labels: ["priority:P0", "area:operations", "type:chore", "effort:L"]
milestone: "M2 Production Safety"
---
# Context

Export tooling is only trustworthy when a real restore is rehearsed.

## Scope

- [ ] Define disaster scenarios and RTO/RPO.
- [ ] Automate snapshot/export checksums.
- [ ] Restore to isolated environment.
- [ ] Verify records, indexes, Candid, module hashes.
- [ ] Write post-drill actions.

## Acceptance criteria

- [ ] Quarterly drill completes within target.
- [ ] Independent operator can follow runbook.
- [ ] Corrupt snapshot is detected.
- [ ] Controller recovery is tested.

## Test plan

- [ ] Lost deploy key
- [ ] Bad upgrade
- [ ] Index corruption
- [ ] Off-chain vault outage

## Dependencies

#019, #024

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
