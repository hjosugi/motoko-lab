---
title: "Measure speculative acceptance against a real draft-target pair"
labels: ["priority:P1", "area:ai", "type:research", "effort:L"]
milestone: "M4 Scale and Interop"
---
# Context

`apps/06_distributed_llm` reports a 33% acceptance rate for autoregressive drafting and 20% for diffusion-style masked drafting. Both numbers come from a 336-token n-gram whose draft head is order 2 and whose target head is order 3. They describe that pair and nothing else.

The interesting quantity is how the same three decoders behave when the draft and target are a real model pair, because acceptance is what converts a block size into a speedup. Without it the round-count reductions in the README are structural facts about the algorithm rather than a prediction about any deployment.

## Scope

- [ ] Run the three decoders against a real draft/target pair off-chain, reusing `Speculative.mo`'s verification rule so the comparison is like for like.
- [ ] Sweep block size and, for the masked draft, the number of unmasking steps.
- [ ] Report acceptance rate, sequential target passes and sequential draft passes, not a bare speedup.
- [ ] Feed the measured counters into `tools/latency-model.mjs` and record which term dominates per profile.
- [ ] State plainly where the on-chain toy and the real pair disagree.

## Acceptance criteria

- [ ] Acceptance rates are reported per prompt set, with the model pair named.
- [ ] Losslessness is verified against the target's own greedy output, as the Motoko tests do.
- [ ] The README's numbers are annotated to say which are toy-model measurements.

## Test plan

- [ ] Identical prompt set across all three decoders
- [ ] Block sizes {1, 2, 4, 8, 16}
- [ ] Masked draft with steps < block, and steps == block as a control

## Dependencies

#041

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
