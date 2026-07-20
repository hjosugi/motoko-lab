# 16-Week Roadmap

1週間12〜18時間を想定します。各週の最後に動くartifactを残してください。

## Phase 1: Language and Runtime

### Week 1 — Toolchain and syntax

- `icp-cli`、Mops、pinned `moc`を導入
- primitive types、records、variants、options、patterns
- `labs/01`と`labs/02`
- 成果物: counter + typed domain model

### Week 2 — Actors and Candid

- query/update/shared/caller
- Candid typesとcompatibility
- anonymous caller拒否
- 成果物: principal-scoped profile canister

### Week 3 — Persistence and collections

- `persistent actor`
- `mo:core/Map`、ordered keys、pagination
- upgrade前後のstate test
- 成果物: CRUD registry

### Week 4 — Async and inter-canister calls

- await boundary、partial commit、error handling
- sequential/parallel calls
- idempotency key
- 成果物: adapter canister mock

## Phase 2: Practical Services

### Week 5 — Creator Proof Registry

- commit-reveal
- artifact/manifest hash
- revocation and derivation
- 成果物: `apps/01`を自分のschemaに変更

### Week 6 — Merkle Anchoring

- Merkle root、batch metadata、proof verifier
- certified response設計
- 成果物: `apps/02` + off-chain proof test

### Week 7 — Payments and licensing

- ICRC-1/2 concepts
- duplicate payment prevention
- manual confirmationからadapterへ
- 成果物: `apps/03`のpayment mock

### Week 8 — Marketplace workflows

- bounty lifecycle
- escrow boundary、dispute、moderation
- 成果物: `apps/04`

### Week 9 — Metered SaaS

- API key hash、tenant、quota、period reset、idempotency
- 成果物: `apps/05`

## Phase 3: Production Engineering

### Week 10 — Security

- authorization matrix
- trap/DoS/storage growth/front-running/replay
- abuse economics
- 成果物: threat model test cases

### Week 11 — Testing

- unit/model/property/integration/PocketIC
- upgrade rehearsal
- Candid compatibility gate
- 成果物: CI pipeline

### Week 12 — Operations

- controllers、cycles、alerts、backup/export、incident response
- 成果物: staging/mainnet runbook

### Week 13 — Scale

- index/data canister split
- shard routing、hot key、batching、archival
- 成果物: scale design review

## Phase 4: Maintainer and Business

### Week 14 — Compiler internals

- OCaml/Dune/Nix
- AST、type checker、IR、Wasm codegen
- 成果物: traced compiler pipeline note

### Week 15 — Upstream contribution

- reproduce one issue
- add minimal regression test
- submit one focused PR or documentation fix
- 成果物: public issue/PR

### Week 16 — Launch and monetization

- ICP mainnet deployment
- pricing page、onboarding、metrics、support boundary
- five design partnersへ提案
- 成果物: paid pilot or measured pricing experiment

## Weekly review

- 動くものは何か
- 壊れる条件は何か
- upgradeでdataは残るか
- callerを偽装できないか
- cost driverは何か
- customerが支払う理由は何か
- upstreamへ返せる知見は何か
