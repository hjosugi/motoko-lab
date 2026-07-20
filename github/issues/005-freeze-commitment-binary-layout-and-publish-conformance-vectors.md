---
title: "Freeze commitment binary layout and publish conformance vectors"
labels: ["priority:P0", "area:provenance", "type:docs", "effort:M"]
milestone: "M1 Protocol Core"
---
# Context

The commitment layout must be unambiguous across languages and remain stable after launch.

## Scope

- [ ] Write byte-level ABNF or equivalent.
- [ ] Specify principal text validation/canonical form.
- [ ] Specify separators, salt length, digest length, and error behavior.
- [ ] Publish at least 20 positive/negative vectors.
- [ ] Add protocol version negotiation rules.

## Acceptance criteria

- [ ] Independent TypeScript and Rust implementations pass every vector.
- [ ] No concatenation ambiguity exists.
- [ ] Version 1 behavior cannot be changed without a new version.

## Test plan

- [ ] Empty/invalid principal
- [ ] Uppercase input
- [ ] Boundary salt sizes
- [ ] Wrong digest length

## Dependencies

#003, #004

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
