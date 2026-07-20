# Production Architecture

## Reference architecture: Creator Provenance Network

```text
Creator Client
  ├─ local canonicalizer + SHA-256
  ├─ identity signer / wallet
  └─ encrypted source archive
          │
          ▼
API / Frontend Asset Canister
          │
          ▼
Registry Canister ──► Certified Index Canister
    │                        │
    ├─ commitment            ├─ artifact-hash lookup
    ├─ reveal record         └─ owner / time / tag index
    ├─ revocation
    └─ derivation edge
          │
          ├─► Batch Anchor Canister
          ├─► License/Payment Adapter
          ├─► Credential Issuer/Verifier
          └─► Archive Shards

Off-chain availability layer
  ├─ ICP asset canister
  ├─ customer-controlled object storage
  ├─ IPFS/content-addressed mirror
  └─ encrypted evidence vault
```

## Phase 0: single canister

最初は`apps/01`のsingle canisterでproduct discoveryを行います。10人のdesign partnerを得る前にshardingしません。

## Phase 1: index separation

write modelとread modelを分けます。

- registry: authoritative append/revoke
- index: derived data、rebuild可能
- stale indexを検出するcheckpoint
- event sequence number

## Phase 2: tenant/shard routing

routing key候補:

- creator principal prefix
- organization/tenant ID
- artifact hash prefix
- time bucket

推奨はtenant shard + global hash indexです。creatorのdata exportとbillingが容易になります。

## Phase 3: archive

active recordとhistorical eventを分離します。

- primary canister: current stateとrecent events
- archive canister: immutable old events
- root index: range -> archive canister principal
- verification APIはtransparentにarchiveへroute

## Data ownership

- content bytesはcreatorが所有
- registryはhash、manifest metadata、license pointerを保持
- private prompt/sourceはclient-side encryption
- public disclosureとsealed evidenceを分離
- deletion不能なpublic chainへpersonal dataを直接書かない

## Consistency

authoritative writeはregistry update callです。index反映はeventual consistencyでもよいですが、responseにregistry sequenceとindex sequenceを返し、lagを観測可能にします。

## External calls

payment、credential、AI provider、timestamp authorityはadapterで隔離します。

- provider-specific codeをdomain actorへ入れない
- request IDとstate machineを保持
- timeout/retry/duplicateをmodel化
- caller-supplied “paid” flagを信頼しない

## Capacity planning

最初に測る値:

- records/day
- average manifest metadata bytes
- query/update instruction cost
- index amplification
- archive growth
- verification requests/record
- cycle cost per paid customer

`docs/25_COST_AND_CAPACITY_MODEL.md`のsheet modelを使用します。
