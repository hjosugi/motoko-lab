---
title: "Detect byzantine shards in vocabulary-parallel decoding"
labels: ["priority:P0", "area:security", "type:security", "effort:L"]
milestone: "M2 Production Safety"
---
# Context

In `apps/06_distributed_llm` the orchestrator merges worker replies with a max reduction. A worker owns a contiguous slice of the vocabulary and is the only node that scores it, so a compromised worker can return any score for its own range and force any token in that range. The merge has no cross-check and will not notice.

This is a real gap, not a theoretical one: the whole point of sharding is that no other node repeats the work. It is recorded in `docs/THREAT_MODEL.md` and currently unmitigated.

## Scope

- [ ] Decide the trust model explicitly: are workers same-controller infrastructure or third-party nodes?
- [ ] For the untrusted case, evaluate overlapping shard assignment (each range scored by k workers) and the cost it adds.
- [ ] Evaluate spot-checking: the orchestrator recomputes a random slice itself and compares.
- [ ] Consider whether the speculative verifier already covers this — an exact target-side verification re-derives the token, so a byzantine draft cannot change the output.
- [ ] Record which configurations are safe against which adversary.

## Acceptance criteria

- [ ] The threat model states, per strategy, whether a single malicious worker can change the output.
- [ ] At least one configuration is demonstrated in which it cannot.
- [ ] The cost of that configuration is measured in rounds and bytes, not asserted.

## Test plan

- [ ] A deliberately lying worker canister in the `pocket-ic` harness
- [ ] Verify the unprotected path does change the output, so the test is meaningful
- [ ] Verify the protected path does not

## Dependencies

#002

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
