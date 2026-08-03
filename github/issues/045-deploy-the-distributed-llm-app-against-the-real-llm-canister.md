---
title: "Deploy the distributed LLM app against the real LLM canister"
labels: ["priority:P1", "area:ai", "type:feature", "effort:M"]
milestone: "M4 Scale and Interop"
---
# Context

`apps/06_distributed_llm` has been run on `pocket-ic` 14.0.0 with all six canisters installed, and its LLM integration has been exercised against `llm_shim`, a local canister serving the same `v1_chat` interface. What has not been exercised is the real thing: a pulled `llm` canister backed by Ollama or the Intelligence Gateway locally, and `w36hm-eqaaa-aaaal-qr76a-cai` on mainnet.

Two parts of the integration can only fail there. `autoWire` depends on `icp deploy` injecting `PUBLIC_CANISTER_ID:<name>` for project canisters, which the `pocket-ic` harness does not do. And the cycle policy in `LlmClient.mo` — no cycles for free models, 100B for paid ones — has never actually moved a cycle.

## Scope

- [ ] `icp network start -d` and `icp deploy`, then `autoWire`, and confirm the workers configure themselves without pasted principals.
- [ ] Point `setLlmCanister` at a pulled `llm` canister and confirm a real completion comes back.
- [ ] Confirm `LlmClient.FREE_MODELS` still matches what the LLM canister charges for; the list is hardcoded and will go stale.
- [ ] Verify the paid path attaches cycles and that the unused remainder is refunded.
- [ ] Record the response-size and prompt-size limits actually enforced.

## Acceptance criteria

- [ ] A completion from a real model is recorded, distinguishable from shim output (which is prefixed `[shim] `).
- [ ] `autoWire` produces a working four-shard cluster from a fresh `icp deploy`.
- [ ] The cycle policy is confirmed by a measured balance change, not by reading the source.

## Test plan

- [ ] Fresh local network, full deploy, `autoWire`, `benchmark`
- [ ] Free model and paid model, with the canister's cycle balance recorded either side
- [ ] Prompt at and above the documented size limit

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
