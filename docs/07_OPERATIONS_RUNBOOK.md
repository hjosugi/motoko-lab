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

| Signal | Warning | Critical |
|---|---:|---:|
| cycle runway | <30 days | <7 days |
| index lag | >60 sec | >10 min |
| pending payment | >5 min | >30 min |
| failed update rate | >1% | >5% |
| archive growth deviation | >2x baseline | >5x baseline |
| upgrade smoke failure | any | any |

値は実測で調整します。

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
