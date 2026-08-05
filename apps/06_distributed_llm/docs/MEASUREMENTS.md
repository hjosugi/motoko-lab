# Measurements — 06 Distributed LLM

Recorded 2026-08-03. Reproduce with the commands below; the numbers are counters,
not timings, so they do not depend on the machine.

Toolchain: `moc` 1.11.1, `mo:core` 2.6.0, `pocket-ic` 14.0.0, `didc` 0.4.0,
Node 22. `mo:core` was vendored into `.mops/` because the Mops registry
(`icp-api.io`) was unreachable from the recording environment.

## What ran

```
scripts/check_all_apps.sh        6/6 apps: mops check, mops test, mops build   PASS
make test-offline                8/8 Motoko test files                          PASS
make sim                         cluster of 4 workers + orchestrator + shim     PASS
node tools/latency-model.test.mjs   10 strategies x 6 network profiles          PASS
node tools/pocket-ic-e2e.mjs     6 canisters installed on a replica, benchmark  PASS
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
```

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

## Latency projection

`tools/latency-model.mjs` applies `rounds x rtt + bytes / bandwidth + compute` to
the counters above. It is an estimate, not a benchmark; its purpose is to show
which term is large.

| profile | dominant term | what helps |
|---|---|---|
| `ic-subnet` (rtt 1s) | network | fewer rounds: `arDraft` 10.0s -> 6.0s |
| `home-p2p` (10 Mbit/s, `--scale 1000`) | transfer | fewer bytes: dense 22.16s -> 8-bit 3.60s -> 2-bit 1.59s |
| `datacenter` | compute | distributing buys nothing |

## Not run

- `icp network start -d` / `icp deploy`. The network launcher is fetched through
  `api.github.com`, which the recording environment blocks. The replica path was
  covered with `pocket-ic` instead, so `icp.yaml` and `autoWire` remain
  unexercised.
- Mainnet deployment, and any call to a real model behind `v1_chat`.
- Upgrade rehearsal.
- Cycle consumption. The counters are rounds and bytes, not instructions.
