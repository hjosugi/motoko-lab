# Operations Runbook

## Daily checks

- canister status and module hash
- cycles balance and burn rate
- error/reject rate
- update/query latency
- record/order/usage growth
- index lag
- payment adapter pending queue

## Alert thresholds

The thresholds and their warning/critical split are defined, with the signals
and routing, in [29_OBSERVABILITY.md](29_OBSERVABILITY.md) and the reviewed
inventory `observability/alerts.json`; each alert below has a first response.

| Signal | Warning | Critical |
|---|---:|---:|
| cycle runway | <30 days | <7 days |
| index lag | >60 sec | >10 min |
| pending payment | >5 min | >30 min |
| failed update rate | >1% | >5% |
| archive growth deviation | >2x baseline | >5x baseline |
| upgrade smoke failure | any | any |

値は実測で調整します。

## Alert routing and runbooks

Every critical alert routes to the pager and names one of these sections. The
steps assume the canister is still answering; if telemetry itself is down, start
at [Telemetry gap](#telemetry-gap).

### Cycle runway

1. Identify the canister and its `cycle_runway_days`; a runway under 7 days is a
   page, under 30 a warning.
2. Find what changed in `cycles_burn` — a new workload, a retry loop, a growing
   stable structure — before topping up, so the cause is known.
3. Top up from the cycles reserve; confirm the burn returns to baseline.
4. If the burn does not fall, escalate to SEV-2 and consider throttling the write
   path (#22).

### Index lag

1. Compare the index high-water mark with each shard's (#23); lag is per shard.
2. A single lagging shard is a subscriber problem, not a write problem: restart
   the subscriber from its high-water mark.
3. Confirm writes are still accepted and duplicates are resolved late, not
   wrong; the index is order-independent.
4. If lag does not recover, the index is degraded but not corrupt — say so, and
   do not rebuild under load.

### Pending payment age

1. Read the payment queue's oldest pending item and which ledger it is on.
2. Distinguish a slow ledger from a stuck confirmation: a `confirmPayment` that
   is safe to repeat is never the cause (#12).
3. Retry the confirmation; if the ledger is unreachable, payments stay pending
   and nothing is half-applied.
4. A queue that keeps growing is a SEV-2 billing block — escalate.

### Failed update rate

1. Break the rate down by method and by reject reason before acting.
2. A single method failing is a release problem; a broad failure is a subnet or
   workload problem.
3. If a recent deploy is the only change, roll forward to the previous module
   hash (the release was reproducible, #29) and record the annotation.
4. Above 5% sustained is SEV-1 if it touches funds or authorization.

### Archive growth deviation

1. Compare growth with the baseline window, per archive and per shard.
2. A step change after a deploy is usually a new field or index; a smooth rise is
   usually workload.
3. If it is neither, treat it as possible abuse and review the write paths
   (#22) before capacity.

### Upgrade smoke failure

1. Any failure is a stop: do not proceed to the rest of the rollout.
2. The upgrade is recorded only if it committed; a failed migration leaves the
   previous version serving (#16).
3. Restore the previous module hash, then fix forward and re-run the smoke test.
4. Record the incident and the module hash in the deployment annotation.

### Telemetry gap

1. This alert means the monitor cannot see, not that everything is fine. Assume
   unknown until proven otherwise.
2. Check the scrape agent and the metrics store first; then the canister's
   `canister_status`.
3. Do not silence a gap with a lower threshold — a canister that stopped
   reporting and a canister that is healthy look the same without telemetry.
4. The gap resolves when the backend answers; a gap that outlasts the incident
   should become a ticket against the metrics path.

### Silent shard

1. One shard did not report; the cluster aggregate is over the others (#23).
2. Check whether the shard is unavailable to writes as well (its tenants cannot
   write, and nothing is half-applied) or only to metrics.
3. A metrics-only silence is a scrape problem; an unavailable shard is SEV-1 for
   its tenants.
4. Confirm the index's high-water mark for that shard shows the silence.

### Deployment annotation

1. A module hash changed without a matching annotation. Identify the change from
   `canister_status`.
2. If it was a legitimate deploy, add the annotation (canister, version, hash,
   time, author).
3. If it was not, treat it as a possible unauthorized upgrade: SEV-1, review the
   controller set (#26), and follow the SEV-1 sequence.


## Incident levels

- SEV-1: funds、authorization、data loss、global outage
- SEV-2: major feature unavailable、index corruption、billing blocked
- SEV-3: degraded latency、partial UI issue
- SEV-4: documentation/low-risk defect

## SEV-1 sequence

1. incident commanderを決める
2. write pathを停止またはread-only化
3. controller/module hash/canister statusを記録
4. exploit windowとaffected recordsを特定
5. customer communicationを開始
6. forward fixをstagingでrehearse
7. production upgradeとverification
8. postmortem、test、issue、runbook更新

## Backup and export

blockchain上だからbackup不要ではありません。

- portable export format
- manifest and record count checksum
- shard/index mapping
- module hash and Candid version
- encrypted private evidence backup
- restore rehearsal

## Key and controller management

- personal browser identityをsingle pointにしない
- hardware-backed or organization-managed keys
- two-person production deploy
- emergency controllerの定期確認
- offboarding checklist

## Customer support

証跡serviceでは、technical supportとauthorship disputeを分離します。

- technical: failed commit、hash mismatch、availability
- policy: abuse report、false claim、license dispute
- legal: takedown、court order、jurisdiction

canister codeだけで法的紛争を自動解決しません。
