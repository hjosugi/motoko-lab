# Observability, cycle alerts and service-level indicators

Issue #24. Status: design, with an executable model
(`tools/observability/model.mjs`, 91 checks in `tools/observability/model.test.mjs`,
run offline in CI) and a reviewed alert inventory (`observability/alerts.json`)
that `scripts/check_observability.py` holds against this document and the
runbook. Nothing here is deployed; the reference apps are single canisters, and
the metrics path below is what a production deployment would collect, not a
service that exists today.

Operating a registry is a claim about time: that someone will notice a canister
running out of cycles before it stops, that a payment queue growing without
bound is visible before a customer is, that a shard which has stopped reporting
is not read as a shard with nothing wrong. A dashboard someone has to remember
to open is not a control. This document defines the signals, where they come
from, the thresholds, and who is woken — and the model makes the claims about
time executable.

## Signals and the metrics schema

Every signal has a unit, a direction and an aggregate, because the three
questions are decided by the type and not by the alert. `observability/alerts.json`
is the machine-readable copy of this table; the document and the file are checked
against each other.

| Signal | Unit | Worse | Aggregate across shards | Source |
|---|---|---|---|---|
| `cycle_runway_days` | days | below | min | derived from balance and burn |
| `cycles_balance` | cycles | low | sum | `canister_status` |
| `cycles_burn` | cycles/second | high | sum | balance delta over the window |
| `heap_bytes` | bytes | high | sum | `canister_status` |
| `stable_bytes` | bytes | high | sum | `canister_status` |
| `record_count` | count | growth | sum | canister query |
| `usage_event_count` | count | growth | sum | canister query |
| `failed_update_rate` | ratio | high | max | reject counters |
| `pending_payment_age_seconds` | seconds | high | max | payment queue |
| `index_lag_seconds` | seconds | high | max | index high-water mark vs shard |
| `growth_deviation` | ratio | high | max | growth vs baseline |
| `upgrade_smoke_failed` | boolean | — | max | post-upgrade smoke test |
| `telemetry_gap` | boolean | — | max | a scrape or a shard that stopped |
| `shard_silent` | boolean | — | max | a shard that did not report |
| `annotation_missing` | boolean | — | max | module hash changed without an annotation |
| `module_hash` | hex64 | change | unique | `canister_status` |

Two of these are decisions worth stating.

**Runway, not balance.** A cycles balance alone says nothing about when it runs
out and a burn rate alone says nothing about when; `cycle_runway_days =
balance / burn_per_second / 86400` combines them. A canister that is not burning
has an *unbounded* runway, not a zero one — reporting "no burn" as "no runway"
would page on a quiet canister. The input `cycles_balance` and `cycles_burn` are
recorded beside it so the arithmetic can be audited.

**Rates are never summed.** Three shards each failing 4% of updates have a 4%
failure rate, not 12%; the cluster value is the maximum. Balances and counts sum,
lag and rates take the worst shard, runway takes the minimum. The aggregate is
part of the signal's definition, in `alerts.json`, so it is a decision in the
reviewed inventory rather than a choice in a dashboard query someone edits later.

**A missing value is never a zero.** An aggregate over no samples returns
nothing, and a shard that did not report is returned as *missing*. This is the
same rule the sharding index applies to a shard's high-water mark (#23): silence
is information, and folding it in as zero would report a partition that has
stopped as a partition that is healthy.

## Collection path

```
canister_status  ─┐
reject counters   ├─▶ per-canister scrape ─▶ per-shard aggregate ─▶ alert rules ─▶ route
index high-water ─┤        (agent)               (by signal.aggregate)      │
payment queue    ─┘                                                          ├─▶ pager (warning, critical)
                                                                             └─▶ ticket / digest
```

- **Per canister.** `canister_status` gives module hash, cycles, heap and stable
  memory; the counters (records, usage events, rejected updates) and the payment
  queue come from the canister's own queries. Each sample carries its canister id
  and the deployment annotation it belongs to.
- **Per shard.** Where a signal is partitioned (#23), the samples are aggregated
  by the signal's rule before a threshold is applied. A shard that reports
  nothing is a `shard_silent` event against that shard, and the cluster aggregate
  is computed over the shards that did report, with the missing ones named.
- **Staleness.** A sample older than the scrape interval is not a current
  reading. The model treats a signal with no sample as `unknown`, never `ok`, and
  a scrape that has stopped raises `telemetry_gap` — a monitor that cannot see is
  not a monitor that sees nothing wrong.
- **Deployment annotation.** Every deploy records `{ canister, module_hash,
  version, at, by }`. A module hash that changes without a matching annotation is
  an `annotation_missing` ticket, so an alert can always say which bytes were
  running when it fired.

## Thresholds

The numbers are the operations runbook's, restated here as the reviewed
inventory. They are starting points to be replaced by measured values (#30), not
targets.

| Alert | Signal | Warning | Critical |
|---|---|---|---|
| `cycle-runway` | `cycle_runway_days` | `< 30` | `< 7` |
| `index-lag` | `index_lag_seconds` | `> 60` | `> 600` |
| `pending-payment-age` | `pending_payment_age_seconds` | `> 300` | `> 1800` |
| `failed-update-rate` | `failed_update_rate` | `> 0.01` | `> 0.05` |
| `archive-growth-deviation` | `growth_deviation` | `> 2` | `> 5` |
| `upgrade-smoke-failure` | `upgrade_smoke_failed` | any | any |
| `telemetry-gap` | `telemetry_gap` | any | any |
| `shard-silent` | `shard_silent` | any | any |
| `deployment-annotation` | `annotation_missing` | any | — |

Each rule also carries three timings, because a threshold alone produces either
noise or blindness:

- **`for_seconds`** — the breach must last this long before it pages. One bad
  sample is not an incident; a burst shorter than `for_seconds` resolves without
  ever notifying anyone.
- **`clear_seconds`** — the clear hysteresis. Once firing, a brief recovery below
  the line does not resolve the alert, so a signal flapping across the line is
  one alert, not a page per crossing.
- **`repeat_seconds`** — a reminder while it is still firing, measured from the
  last page, so frequent samples cannot push the reminder out forever. A second
  fire, an escalation from warning to critical, and a resolution are state
  changes and are never swallowed as a repeat.

## Dashboard and alert routing

The dashboard is a view of the same signals, not a second source of truth, so
what is on it is exactly what can page. It shows, per canister and per shard: the
deployment annotation and module hash, the cycle runway, heap and stable memory,
the counts, the failed-update rate, the pending payment age, and the index lag
against each shard's high-water mark. The cluster row shows the aggregate and how
many shards reported.

Routing is by severity and rule, in `alerts.json`:

| Route | Channel | For |
|---|---|---|
| `pager` | primary on-call, 5-minute ack | every critical alert |
| `ticket` | ops queue | `archive-growth-deviation`, `deployment-annotation` |
| `digest` | daily email | recorded-only signals and resolved incidents |

**Storm guard.** Once more than `maxPerWindow` alerts page inside the window,
individual pages stop and one summary stands in for them; the suppressed events
are still recorded, so nothing is lost and a responder is not paged once per
canister in a rack. A resolution is never suppressed — an all-clear is never part
of a storm.

**Runbook links.** Every critical alert names a runbook anchor in
[07_OPERATIONS_RUNBOOK.md](07_OPERATIONS_RUNBOOK.md), and
`scripts/check_observability.py` fails the build if any anchor does not resolve
or any critical rule lacks one. The model refuses to build a manager around a
critical rule with no runbook, so the failure is at the code boundary too.

## Telemetry privacy

Metrics are operational data about canisters, not about creators, and the design
keeps it that way:

- **No principal, tenant or content in a metric.** Counts, balances, durations
  and module hashes only. Per-tenant counters (#22) are aggregated to a shard
  before they leave it; a metric label that could name a creator is a defect, not
  a feature.
- **The deployment annotation names an operator, by their choice.** It is
  release metadata — who deployed which version — not an identity of a creator.
- **Alert text carries identifiers, not payloads.** A pending payment alert names
  the queue and the oldest age, not the payer or the invoice contents.
- **Retention is bounded and stated.** Samples are kept long enough to compare
  against the baseline (the `growth_deviation` window) and no longer; long-term
  records are the certified chain (#6), not the metrics store.
- **The metrics store is not authoritative.** It can be dropped and rebuilt from
  the canisters, like the sharding index (#23); a compromise of it can hide
  alerts, which is itself what `telemetry_gap` is for, but cannot alter a record.

## Test plan

| Case | Model check |
|---|---|
| cycle runway alert fires | a 10-day runway warns after `for_seconds`, a 5-day runway escalates to critical, both carrying the runbook |
| pending payment / index lag visible | an aged pending payment and a lagging index each page as critical, and the page names which |
| deployment annotation recorded | annotation binds canister, version, module hash, time, author; a change without one, or with a mismatched one, is a finding |
| runbook from every critical alert | no critical notification lacks a runbook, and the checker requires every anchor to resolve |
| metrics backend unavailable | a stopped scrape raises `telemetry-gap`, no unreported signal reads as `ok`, and the gap resolves when the backend answers |
| alert storm | only `maxPerWindow` distinct alerts page inside the window; the rest are recorded as suppressed; repeats are coalesced |
| false positive | a burst shorter than `for_seconds` never pages; a brief recovery inside `clear_seconds` does not resolve a firing alert |
| multi-shard aggregation | sums sum, rates and lag take the worst shard, and a silent shard is missing rather than zero |

## Acceptance

- **Cycle runway alert fires in test** — yes, with an escalation to critical and
  the runbook attached.
- **Pending payment/index lag are visible** — yes, as distinct critical alerts
  naming the queue and the index.
- **Deployment annotation is recorded** — yes, bound to the running module hash,
  with a finding when one is missing or does not match.
- **Runbook links from every critical alert** — yes, enforced in the model and by
  `scripts/check_observability.py` against this repository's runbook.

## What remains

This is the design and its executable core. Before it is an operating monitoring
system: the scrape agent and metrics store themselves; the dashboard as code
rather than a table in a document; a pocket-ic walkthrough of the collection path
against a real canister; the measured baselines that replace the thresholds
(#30); and the growth-baseline job behind `archive-growth-deviation`. The
signals, thresholds, routing and runbook links are decided here so those pieces
have a contract to implement, and `observability/alerts.json` is reviewed in CI
so they cannot drift.
