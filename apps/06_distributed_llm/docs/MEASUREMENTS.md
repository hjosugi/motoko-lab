# Measurements — 06 Distributed LLM

Recorded 2026-08-03, extended 2026-08-05 with the access, quota, cycle and
byzantine measurements. Reproduce with the commands below; except for the cycle
figures the numbers are counters, not timings, so they do not depend on the
machine.

Toolchain: `moc` 1.11.1, `mo:core` 2.6.0, `pocket-ic` 14.0.0, `didc` 0.4.0,
Node 22. `mo:core` was vendored into `.mops/` because the Mops registry
(`icp-api.io`) was unreachable from the recording environment.

## What ran

```
scripts/check_all_apps.sh        6/6 apps: mops check, mops test, mops build   PASS
make test-offline                8/8 Motoko test files                          PASS
make sim                         cluster of 4 workers + orchestrator + shim     PASS
node tools/latency-model.test.mjs   10 strategies x 6 network profiles          PASS
node tools/pocket-ic-e2e.mjs     8 canisters on a replica, 55 checks            PASS
```

## Benchmark

Prompt `speculative decoding uses`, 24-token budget, block 4, 2 unmasking steps,
4 shard workers, vocabulary 336. The Motoko interpreter (`make sim`) and the
`pocket-ic` replica (`tools/pocket-ic-e2e.mjs`) produce identical counters.

```
strategy                       tgtRnd drfRnd accept%  calls   bytes  lossless
baseline                           10      0       0      0       0  yes
arDraft                             6     24      33      0       0  yes
maskedDraft                         6     12      20      0       0  yes
shardedArgmax                      10      0       0     40     640  yes
shardedDense                       10      0       0     40   27200  yes
shardedQuantized/8bit/floor        10      0       0     40    4000  yes
shardedQuantized/4bit/nearest      21      0       0     84    4872  NO
shardedDraft                        6     24      33     96    1536  yes
```

`shardedDraft` is the fan-out used for the *draft* head with an exact local
target pass verifying it. It is the only sharded strategy whose output a
malicious worker cannot change (see `THREAT_MODEL.md`), and it is also the
cheapest in bytes, because a draft only needs each shard's local winner.

`tgtRnd` is the number of sequential target passes, which on a distributed
deployment is the number of network round trips. `drfRnd` is the sequential draft
passes, assumed local. `lossless` is measured, not asserted: each run is compared
token for token against plain autoregressive decoding of the same prompt.

## Quantization

Swept over every context position of the corpus (398 positions), both heads.

```
head     rounding  bits  bytes/step  flipped      near-ties (top2 within 1%)
target   floor     2     92          0 / 398      78 / 398
target   floor     4     176         0 / 398      78 / 398
target   floor     8     344         0 / 398      78 / 398
target   nearest   2     92          43 / 398     78 / 398
target   nearest   4     176         36 / 398     78 / 398
target   nearest   8     344         19 / 398     78 / 398
draft    nearest   8     344         37 / 398     138 / 398
exact    -         64    2688        0 (by definition)
```

Truncating quantization never flips the chosen token, at any bit width, because
its error is one-sided and the maximum is reproduced exactly. Round-to-nearest
does. Reporting the first row without the rounding mode would be a false claim,
which is why both are measured.

## Byzantine detection

`test/fixtures/LyingWorker.mo` installed as shard 3 of 4 — same Candid interface
as the honest worker, scores its range correctly, then reports a token of its own
choosing with a score above the honest ceiling of `W3 * Lm.SCALE`.

```
configuration             calls  bytes   probes  output=honest  outcome
trusting (replication 1)  96     1536    0       NO             believed, and WRONG
replication 2             8      128     0       -              rejected on round 0: disagreement shard 2, workers 2/3
replication 3             12     192     0       -              rejected on round 0: disagreement shard 1, workers 1/3
replication 4             16     256     0       -              rejected on round 0: disagreement shard 0, workers 0/3
spot check (rotating)     16     256     4       -              rejected on round 3: spot check failed, shard 3, worker 3
sharded draft, verified   160    2560    0       yes            believed, and correct, accept 0%
```

`calls` and `bytes` are what a run spent before it stopped, so a rejected row is
the cost of catching the lie rather than the cost of a full decode. The
unprotected row is the control: without it the rows below prove nothing.

Cost of verification on the *honest* cluster, `#dense` so the bytes are the
activation itself:

```
configuration             rounds  calls  bytes   lossless
dense, replication 1      10      40     27200   yes
dense, replication 2      10      80     54400   yes
dense, replication 3      10      120    81600   yes
dense, replication 4      10      160    108800  yes
dense, spot check         10      40     27200   yes
sharded draft             6+24    96     1536    yes   accept 33%
```

Replication multiplies calls and bytes and leaves rounds alone, because the calls
are independent and issued before the first `await`. The spot check costs neither
— it is local instructions. With the liar present, `shardedDraft` took 160 calls
instead of 96 and acceptance fell 33% -> 0%: the lie costs acceptance, not
correctness.

## Access, quota and cycles

On `pocket-ic`, 55 assertions in `tools/pocket-ic-e2e.mjs`. The interpreter
cannot cover any of this: it has no real `caller` and no cycle accounting.

```
anonymous principal        generate / benchmark / askLlmCanister  -> #anonymousNotAllowed
unknown principal          generate / benchmark                   -> #unauthorized
                           and stats().calls is unchanged, so the refusal did no work
allowlisted principal      generate                               -> ok
                           askLlmCanister("gemma3:27b", ...)      -> #unauthorized  (paid model, owner pays)
                           askLlmCanister("llama3.1:8b", ...)     -> ok             (free model)
open access on             any named principal                    -> ok
                           anonymous principal                    -> #anonymousNotAllowed
```

Quota, with `unitsPerWindow = 200` over one hour:

```
fresh principal            remaining 200
24-token local decode      remaining 176        (1 unit per model pass)
benchmark                  #quotaExceeded { limit 200, used 24, requested 672, resetInNanos 3.6e12 }
                           stats().calls unchanged: refused before running, not truncated
owner                      benchmark ok, quotaOf().exempt = true
```

Cycles, one `benchmark` with four workers:

```
balance before             999_999_987_687_302_982
balance after              999_999_984_480_442_434
observed drop                        3_206_860_548
sum of Report.cyclesSpent            2_804_749_974
```

The reported figure is the balance drop measured *inside* each message, so it
covers the calls that message sent. The execution charge for the message itself
lands after it returns, which is why the externally observed drop is larger. The
invariant the harness asserts is `reported <= observed`; equality would mean the
meter was measuring the wrong thing.

A canister installed with 1T cycles — below the 3T `MIN_CYCLE_RESERVE` — refuses
`generate`, `benchmark` and `askLlmCanister` with
`#lowCycles { balance = 918_327_983_516; reserve = 3_000_000_000_000 }` instead of
fanning out towards its freezing threshold.

## Latency projection

`tools/latency-model.mjs` applies `rounds x rtt + bytes / bandwidth + compute` to
the counters above. It is an estimate, not a benchmark; its purpose is to show
which term is large.

| profile | dominant term | what helps |
|---|---|---|
| `ic-subnet` (rtt 1s) | network | fewer rounds: `arDraft` 10.0s -> 6.0s |
| `home-p2p` (10 Mbit/s, `--scale 1000`) | transfer | fewer bytes: dense 22.16s -> 8-bit 3.60s -> 2-bit 1.59s |
| `datacenter` | compute | distributing buys nothing |

## Local replica (`icp network start` + `icp deploy`)

Run 2026-08-06 with icp-cli 1.2.0 and network launcher 15.0.0, which bundles
pocket-ic 15.0.0. This is the path `pocket-ic-e2e.mjs` cannot cover: real
canister creation, controller checks, `PUBLIC_CANISTER_ID` injection, an HTTP
gateway, and cycle balances that come from somewhere.

Verified:

- `icp.yaml` deploys all six canisters, including the four workers declared
  inline against one shared source file.
- `autoWire` assembles the four-shard cluster from injected environment
  variables, with no principals pasted by hand.
- `llmTarget` resolves to the deployed `llm_shim` principal, and
  `askLlmCanister` round-trips `v1_chat` through it.
- `benchmark` returns the same counters as the interpreter and pocket-ic.
- Upgrade rehearsal: `icp deploy` a second time, then re-run. Stable state
  (`calls`, `workers`, `wireBytes`), the `llmOverride`, and each worker's shard
  assignment all survive, and the benchmark output is byte-identical across the
  upgrade.

Two defects in the documented flow, both now fixed in the Makefile and README:

- **Identity ordering.** `icp deploy` makes the currently selected identity the
  controller. The default is `anonymous`, which every gated endpoint rejects, so
  deploying as anonymous yields a cluster nobody can configure. Switching
  identity afterwards does not recover it — the next `icp deploy` fails with
  `IC0512 Only controllers ... can call ic00 method update_settings`. The
  identity has to exist and be selected before the first deploy.
- **Cycle floor.** `icp deploy` provisions ~1.4T cycles locally
  (`1_498_586_747_137` on an untouched worker). `MIN_CYCLE_RESERVE` is 3T, so the
  first `benchmark` returns
  `#lowCycles { balance = 1_416_838_088_150; reserve = 3_000_000_000_000 }`
  and nothing runs. Correct behaviour, wrong default for the local flow; the
  documented steps now include a top-up.

### Candid compatibility across releases

Upgrading a cluster deployed from #41 to v2026.08.06 is a **breaking** Candid
change and `icp deploy` refuses it:

```
Method askLlmCanister: func (text, text) -> (Result_4)
  is not a subtype of func (text, text) -> (Result_1/1)
Method configure: func (nat, nat) -> (Result)
  is not a subtype of func (nat, nat) -> (Result/1)
```

Adding a case to an error variant widens it, and in *return* position a wider
variant is not a subtype: a client that matches the old cases exhaustively breaks
on the new tag. The gate is working as intended — worth knowing before assuming
an error-type addition is additive.

### Cycles on a replica

First real figures; the interpreter has no cycle accounting and reports 0.
`cyclesSpent` is a balance delta, so it covers the calls a message made but not
that message's own execution charge, which is deducted after it returns.

```
baseline / arDraft / maskedDraft        0            (no fan-out)
shardedArgmax                     914_323_992
shardedDense                      926_466_070
shardedQuantized/8bit/floor       926_504_390
shardedQuantized/4bit/nearest   1_898_702_132       (21 rounds, not 10)
shardedDraft                    2_187_247_652
```

The meter tracks the fan-out, which is what it is for. These are pocket-ic
prices, not mainnet prices.

## Not run

- Mainnet deployment, and any call to a real model behind `v1_chat`.
- Instruction counts. The cycle figures above are balance deltas on a local
  replica, not mainnet prices; what they establish is that the meter tracks the
  fan-out, not what a mainnet call would cost.
- A quota window actually rolling over. `Quota` takes `now` as an argument and
  `test/Quota.test.mo` covers the rollover directly; the replica harness only
  covers a single window, because advancing the replica an hour would add a
  minute to every run for no additional coverage.
- Colluding workers. Every measurement above has exactly one byzantine node.
- Upgrade *across a breaking Candid change*. The gate refuses it, which is the
  documented behaviour; migrating a live cluster over one is untried.
