---
title: "Compile all reference apps with the current pinned toolchain"
labels: ["priority:P0", "area:build", "type:chore", "effort:M"]
milestone: "M0 Compile Baseline"
---
# Context

The generated Motoko applications were static-reviewed but not compiled in the artifact environment.

## Scope

- [ ] Install Node 22+, icp-cli, ic-wasm, and Mops.
- [ ] Run mops install/check/test/build in every app.
- [ ] Record every compiler diagnostic with app and file.
- [ ] Patch source/Candid/config without weakening security requirements.
- [ ] Update VALIDATION_STATUS.md with exact versions and results.

## Acceptance criteria

- [ ] All five apps compile with moc 1.11.1 or a documented newer version.
- [ ] All generated Candid files match the actor interfaces.
- [ ] No warning is silently ignored; accepted warnings are documented.
- [ ] CI command exits zero from a clean checkout.

## Test plan

- [ ] Clean Linux CI run
- [ ] Clean macOS run when available
- [ ] Delete caches and rerun

## Dependencies

None

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
