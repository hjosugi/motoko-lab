---
title: "Gate and meter the distributed LLM orchestrator endpoints"
labels: ["priority:P1", "area:operations", "type:security", "effort:M"]
milestone: "M2 Production Safety"
---
# Context

`benchmark` runs every strategy on one prompt, so a single call fans out across all workers several times over. It is unauthenticated by design, which is right for a reference app and wrong for anything deployed. Prompt length and token budget are bounded, but the number of inter-canister calls per ingress message is not something the caller pays for.

`askLlmCanister` additionally attaches 100B cycles for paid models. A canister with an empty balance traps; a canister with a balance funds arbitrary callers' prompts.

## Scope

- [ ] Add an allowlist or per-principal quota to `benchmark` and `generate`.
- [ ] Meter cycles consumed per call and expose it alongside the existing round and byte counters.
- [ ] Decide and document who pays for `askLlmCanister`, and reject calls that would draw down the canister's balance for an unknown caller.
- [ ] Reject rather than clamp when a caller exceeds their quota, so the limit is visible.

## Acceptance criteria

- [ ] An unauthorized principal cannot cause a fan-out.
- [ ] `Report` carries a cycles figure that matches an independent measurement.
- [ ] The freezing threshold cannot be reached through repeated `benchmark` calls in a test.

## Test plan

- [ ] Quota exhaustion returns an error rather than a partial result
- [ ] Cycle balance before/after a fixed workload
- [ ] Anonymous caller rejected on every gated endpoint

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
