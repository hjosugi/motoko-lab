---
title: "Add dependency provenance and reproducible-build verification"
labels: ["priority:P0", "area:supply-chain", "type:security", "effort:L"]
milestone: "M2 Production Safety"
---
# Context

Compiler, Mops packages, recipe, npm tools, and CI images are part of the trust boundary.

## Scope

- [ ] Lock dependencies and hashes.
- [ ] Record source/license/maintainer for every package.
- [ ] Generate SBOM where possible.
- [ ] Verify release artifacts and module hash.
- [ ] Define dependency update review.

## Acceptance criteria

- [ ] Clean builders reproduce Wasm.
- [ ] Unexpected dependency change fails review.
- [ ] Licenses are compatible.
- [ ] Critical dependency advisory has response path.

## Test plan

- [ ] Compromised package
- [ ] Yanked version
- [ ] Recipe update
- [ ] CI image drift

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
