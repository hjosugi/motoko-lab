# Threat Model

- an unclaimed worker is captured by whoever calls `configure` first; the first non-anonymous caller becomes its controller and no later principal can reassign the shard
- a compromised worker can return any score for its own slice, so it can force any token in its range; vocabulary parallelism has no cross-check and a byzantine shard is not detected by the merge
- the orchestrator must therefore treat worker output as untrusted input, not as a shard of its own computation
- `#quantized` with `#nearest` rounding changes the chosen token; a caller that reads `Report.text` without reading `Report.lossless` will silently consume a different answer than the model produced
- a caller can burn the orchestrator's cycles through `benchmark`, which runs every strategy; prompts and token budgets are bounded but the endpoint is unauthenticated by design and should be gated before mainnet
- `askLlmCanister` reaches a canister outside this project; on mainnet the answer is produced by an AI worker outside consensus, so it is auditable but not verified
- attaching cycles to a free model, or omitting them for a paid one, traps the calling canister; `LlmClient.FREE_MODELS` is a hardcoded list and goes stale when the LLM canister changes its pricing
- the corpus is baked into the wasm, so every replica derives identical counts; an operator who ships a modified corpus changes every token id and silently invalidates stored histories
- `maxTokens` is clamped rather than rejected because the real limit is the per-message instruction budget; an unbounded budget is a denial-of-service vector, not a usability nicety
- the model is a 336-token n-gram and holds no user data, so there is no confidentiality boundary here to breach; a real deployment with a real model would have one
