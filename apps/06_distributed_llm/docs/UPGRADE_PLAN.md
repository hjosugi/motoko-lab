# Upgrade Plan

The model is derived data: `Lm.train(Corpus.text)` runs on install and on every upgrade, and both the model and the vocabulary are `transient`. Nothing about them is persisted, so an upgrade cannot leave a half-migrated model behind.

What that buys is bounded. Token ids are positions in a sorted vocabulary built from the corpus, so **changing `Corpus.mo` renumbers every token**. Any stored token sequence, any cached shard assignment and any client that memoised an id becomes wrong without a type error. Treat a corpus edit as a breaking change: bump the package version, and never reinterpret an id recorded before the change.

Stable state is the wiring and the policy — `owner`, `workers`, `llmOverride`, the counters, the `allowed` allowlist, the `quotas` map, `policy`, `openAccess` and `verification` — plus `controller`, `shardIndex` and `shardCount` on each worker. Adding a field to those is compatible; removing or retyping one is not, and `icp` will refuse the upgrade rather than corrupt it.

Two consequences worth stating. The allowlist and the quota ledger **survive an upgrade**, which is the point — an upgrade that silently reopened the canister or handed every caller a fresh budget would be a security regression delivered as a deploy. And `quotas` holds one record per *authorised* calling principal: bounded by the allowlist under the default posture, unbounded under `setOpenAccess(true)`, where any named principal is authorised. `pruneQuotas` drops records whose window has ended; they carry no information, because a principal with no record is treated as having spent nothing, which is exactly what an expired window means. Call it as part of the upgrade if open access has been on.

Shard assignment is recomputed from `(index, count)` on every call through `Sharding.range`, so changing the number of workers needs no migration: call `setWorkers` (or `autoWire`) again and every range is redivided. Do it while no `generate` is in flight — an orchestrator that fans out mid-reassignment can merge replies from two different partitions and produce a token neither partition would have chosen.

Rehearse before release: install, `autoWire`, `benchmark`, upgrade all six canisters, `benchmark` again, and diff the reports. Every `lossless` field must still be `true` for every strategy except the `#nearest` ones, and the baseline text must be byte-identical across the upgrade.
