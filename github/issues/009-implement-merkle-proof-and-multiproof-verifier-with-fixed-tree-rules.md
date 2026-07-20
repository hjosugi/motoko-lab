---
title: "Implement Merkle proof and multiproof verifier with fixed tree rules"
labels: ["priority:P1", "area:crypto", "area:provenance", "type:feature", "effort:L"]
milestone: "M1 Protocol Core"
---
# Context

The Merkle anchor stores roots but does not define or verify leaf/path construction.

## Scope

- [ ] Define leaf domain separation and pair ordering.
- [ ] Define odd-node handling and tree version.
- [ ] Implement single proof verifier.
- [ ] Implement or evaluate multiproof.
- [ ] Publish vectors and performance data.

## Acceptance criteria

- [ ] Proofs generated in TypeScript verify in Motoko or a canonical verifier.
- [ ] Corrupted leaf/path/root fails.
- [ ] Tree version is stored with every batch.
- [ ] No ambiguous concatenation.

## Test plan

- [ ] 1 leaf
- [ ] odd number of leaves
- [ ] duplicate leaves
- [ ] large batch

## Dependencies

#003, #005

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
