# Upgrade and Migration Strategy

## Rules

1. stable data changeをPR descriptionに明示
2. public Candid changeとstable signature changeを別check
3. destructive migrationを避ける
4. migrationをversioned stepへ分解
5. production-like snapshotでrehearse

## Version field

actorへ`schemaVersion : Nat`を持たせ、migration完了後に更新します。data itemにもversionが必要な場合はlazy migrationを検討します。

## Strategies

### Additive

optional/new fieldをdefaultで追加。最も安全。

### Eager migration

upgrade時に全data変換。data量が大きいとinstruction/upgrade risk。

### Lazy migration

read/write時にitemを新versionへ変換。complexityは上がるがlarge data向け。

### Dual read/write

old/new indexを併存し、backfill後にcutover。検索schema変更向け。

## Rehearsal checklist

- old Wasm deploy
- fixture data生成
- export/checksum
- new Wasm upgrade
- record count/hash check
- representative reads/writes
- downgrade禁止条件確認
- cycle/memory/time measurement

## Emergency

bad migration後にold Wasmへ戻せると仮定しません。read-only modeとforward repair methodを準備します。
