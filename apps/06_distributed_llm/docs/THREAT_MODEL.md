# Threat Model

## Can one malicious worker change the output?

The question the vocabulary-parallel design has to answer, per strategy and per
verification setting. "Detected" means the round is rejected and `generate`
returns `#err(#faultyWorker …)` — the caller gets an error, never a wrong answer.

| strategy | `replication = 1`, no spot check | `replication >= 2` | spot check | why |
|---|---|---|---|---|
| `baseline`, `arDraft`, `maskedDraft` | no | n/a | n/a | no worker is involved; these run entirely inside the orchestrator |
| `shardedArgmax` | **yes** | detected | detected within `shards` rounds | the merge is a max reduction over ranges nobody else scores |
| `shardedDense` | **yes** | detected | detected within `shards` rounds | same, with the whole slice on the wire |
| `shardedQuantized` | **yes** | detected | detected within `shards` rounds | same; note the output can also differ for the honest reason that quantization is lossy |
| `shardedDraft` | **no** | no | no | the workers only draft; an exact local target pass re-derives every emitted token |

Measured on `pocket-ic` 14.0.0 with `test/fixtures/LyingWorker.mo` as shard 3 of
4 — a canister serving the identical Candid interface, which is the point: the
orchestrator cannot tell it apart by type. Reproduce with
`node tools/pocket-ic-e2e.mjs`, or in the interpreter with `make sim`.

```
configuration             calls  bytes   probes  output=honest  outcome
trusting (replication 1)  96     1536    0       NO             believed, and WRONG
replication 2             8      128     0       -              rejected on round 0: disagreement shard 2, workers 2/3
replication 3             12     192     0       -              rejected on round 0: disagreement shard 1, workers 1/3
replication 4             16     256     0       -              rejected on round 0: disagreement shard 0, workers 0/3
spot check (rotating)     16     256     4       -              rejected on round 3: spot check failed, shard 3, worker 3
sharded draft, verified   160    2560    0       yes            believed, and correct, accept 0%
```

The forged output is `sharding sharding sharding …` against an honest
`a diffusion model can fill many positions in parallel.` — a single worker owning
84 of 336 vocabulary entries can force any token in its range on every step.

### What each setting costs

Measured on the honest cluster, same prompt and budget, `#dense` so the bytes are
the activation itself:

```
configuration             rounds  calls  bytes   lossless
dense, replication 1      10      40     27200   yes
dense, replication 2      10      80     54400   yes
dense, replication 3      10      120    81600   yes
dense, replication 4      10      160    108800  yes
dense, spot check         10      40     27200   yes
sharded draft             6+24    96     1536    yes   accept 33%
```

* **Replication is linear in bytes and calls and free in rounds.** The calls are
  independent and all issued before the first `await`, so `k` replicas cost `k`
  times the bandwidth at the same latency. On a subnet, where a consensus round
  dominates, that is the cheap axis to spend on; on a bandwidth-bound link it is
  the expensive one.
* **The spot check costs instructions, not bytes.** The orchestrator recomputes
  one range per round itself. It is the only check that survives an adversary who
  controls every replica of a range.
* **`shardedDraft` costs acceptance.** With the liar present the same run took
  160 calls instead of 96 and acceptance fell from 33% to 0% — every proposal was
  rejected by the verifier. The output did not move.

### What none of this covers

* **All replicas of a range lying the same way.** With `replication = k`, `k`
  colluding workers that agree on a lie are indistinguishable from `k` honest
  workers. Replication is only worth its bandwidth if the replicas fail
  independently — different controllers, ideally different subnets. Four workers
  controlled by one principal replicate the fault along with the work.
* **A spot check the adversary can predict.** The rotation is public
  (`round % shards`): a canister has no private randomness, and the only
  unpredictable source on the Internet Computer is `raw_rand`, which costs an
  extra async call per round. A worker that lies only when it is not being looked
  at is not caught. What the rotation does guarantee is that a worker lying on
  *every* round is caught within `shards` rounds, deterministically — measured
  above at round 3 of 4.
* **Which worker lied.** With `replication = 2` the orchestrator learns that two
  workers disagree, not which one is wrong. Three-way replication and a majority
  vote would identify it; this app rejects the round and names both, on the
  grounds that an operator investigating a fault wants both principals anyway.

## Trust model

The default is `replication = 1`, no spot check: **workers are same-controller
infrastructure**. That is the honest reading of `icp.yaml`, where all four
workers are canisters of the same project, deployed by the same principal, from
the same wasm. Under that assumption a byzantine worker means a compromised
controller, and a compromised controller can equally well replace the
orchestrator.

`setVerification` exists for the deployment where that stops being true — third-
party nodes, a marketplace of workers, workers on subnets you do not run. There
the ordering is: `shardedDraft` if the orchestrator can hold the target head
(free, and the guarantee is absolute), otherwise `replication >= 2` across
distinct controllers, with the spot check on top when the replicas might collude.

## Access, quota and cycles

* Every decoding endpoint requires a non-anonymous, authorised caller. After
  install the only authorised principal is the owner — the first non-anonymous
  caller of an admin endpoint. `setOpenAccess(true)` reopens the canister to any
  named principal for demos, still under the quota, and it is off by default.
* `benchmark` is a fan-out amplifier: one ingress message is eight decodes and
  `tokens * workers * replication` inter-canister calls, all billed to this
  canister and none to the caller. `Quota` charges an upper bound on the work
  *before* it runs and refuses rather than truncating, so the limit is visible
  as an error rather than as a surprisingly short answer.
* The quota window is tumbling, not sliding: a caller can spend two windows'
  budget across a boundary. That factor of two is the price of O(1) state per
  principal, and unbounded per-principal state is itself a denial-of-service
  vector.
* The owner is exempt from the quota because it sets the policy; exempting it
  changes nothing an attacker could exploit and stops an operator locking itself
  out of its own canister.
* `askLlmCanister` spends this canister's cycles. Paid models are owner-only
  (`LlmClient.CYCLES_PER_CHAT` is 100B per prompt, so letting anyone else choose
  the model is handing them a spending key); free models stay open to allowlisted
  callers under the quota.
* Every gated endpoint refuses below `Validation.MIN_CYCLE_RESERVE` (3T). A
  canister that falls under its freezing threshold stops answering ingress
  entirely, including the endpoints an operator would use to diagnose and refill
  it, so the floor turns "the canister is gone" into "the canister says no".
  Measured: a canister installed with 1T refuses `generate`, `benchmark` and
  `askLlmCanister` with `#lowCycles { balance; reserve }`.
* `Report.cyclesSpent` is the drop in this canister's own balance across the
  call, so it covers the fan-out. The execution charge for the message itself
  lands after the message returns, which is why the externally observed drop is
  larger — 3.21G observed against 2.80G reported for one `benchmark` on
  `pocket-ic`. It is `moc -r` that reports zero, because the interpreter has no
  cycle accounting.

## Remaining exposure

- an unclaimed worker is captured by whoever calls `configure` first; the first non-anonymous caller becomes its controller and no later principal can reassign the shard
- a worker answers any range it is asked for, not only its own. That is what makes replication possible and it leaks nothing — the model is baked into every worker's wasm — but it does mean a worker cannot enforce its own shard boundary; only the orchestrator's range check does
- `#quantized` with `#nearest` rounding changes the chosen token; a caller that reads `Report.text` without reading `Report.lossless` will silently consume a different answer than the model produced
- `askLlmCanister` reaches a canister outside this project; on mainnet the answer is produced by an AI worker outside consensus, so it is auditable but not verified
- attaching cycles to a free model, or omitting them for a paid one, traps the calling canister; `LlmClient.FREE_MODELS` is a hardcoded list and goes stale when the LLM canister changes its pricing
- the corpus is baked into the wasm, so every replica derives identical counts; an operator who ships a modified corpus changes every token id and silently invalidates stored histories
- `maxTokens` is clamped rather than rejected because the real limit is the per-message instruction budget; an unbounded budget is a denial-of-service vector, not a usability nicety
- the model is a 336-token n-gram and holds no user data, so there is no confidentiality boundary here to breach; a real deployment with a real model would have one
