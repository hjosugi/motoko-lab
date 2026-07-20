# Testing, CI, and Deployment

## Test pyramid

### Pure unit tests

- input bounds
- status transition
- payment/idempotency key construction
- commitment preimage test vector
- pagination cap

### Model tests

domain modelをpure moduleとして実装し、command sequenceを生成します。

- create -> revoke -> create duplicate
- listing -> order -> accept/reject
- quota reset boundary
- bounty cancel/award conflict

### Canister integration tests

PocketIC等で次を実行します。

- distinct principals
- anonymous caller
- upgrade with retained state
- inter-canister reject/timeout
- cycle/memory boundary
- Candid client generated binding

### Protocol conformance tests

- same manifest -> same hash
- key order change -> same canonical hash
- number/Unicode edge case
- domain version mismatch -> failure
- wrong principal/salt -> commitment mismatch
- Merkle proof corruption -> failure

## CI gates

1. source formatting
2. `mops install`
3. `mops check`
4. unit test
5. `mops build`
6. generated Candid diff
7. stable compatibility check
8. PocketIC integration
9. dependency/license scan
10. reproducible Wasm hash

## Environments

- local: disposable identities and canisters
- staging: production-like data shape, no real funds
- production: restricted deploy identity, monitored cycles

config、identity、canister IDを混在させません。

## Release procedure

1. issue/PR scope fixed
2. migration and Candid review
3. staging upgrade rehearsal
4. state/export checksum
5. Wasm hash approval
6. production upgrade
7. smoke queries and writes
8. cycle/memory/error monitoring
9. release note and rollback decision window

## Rollback

code rollbackはstable state rollbackではありません。migration後の旧Wasm再installが安全とは限りません。

- forward fixを基本にする
- destructive migrationを避ける
- migration markerとversionを保存
- old dataを一定期間保持
- emergency read-only modeを用意
