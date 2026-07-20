# Monetization Cases

## Case 1: Caffeine — subscription + usage credits

snapshotの公開pricing:

- Free: app market閲覧/remix、welcome credits
- Host: $5/month、paid builder features、live apps、BYO domain、email、analytics
- Studio: $25/month、Host機能 + App Market publishing等

学び:

- Motoko自体ではなく、time-to-deployed-appを販売する
- subscriptionにusage creditsを組み合わせる
- export/ownershipでplatform lock-in不安を減らす
- public marketでtemplate/remix flywheelを作る

公開pricingは収益性や利益を証明しません。

## Case 2: DEX — transaction-driven fees

ICDex、ICPSwapはon-chain usageが確認できるため、transaction fee、listing、liquidity/staking service、API/data等が収益候補です。

学び:

- volumeはrevenueではない
- liquidity incentiveを差し引く必要がある
- security auditとincident reserveがcost
- token priceをproduct revenueと混同しない

## Case 3: Liquid staking — protocol fee

WaterNeuronは第三者dataでstaking rewardsの一部をDAO revenueにするmodelが追跡されています。Motoko evidenceとは別に、ICP上の明確なrevenue modelとして参考になります。

## Creator Provenance SaaSの推奨model

### Free

- 月50 commitments
- public verification
- community support

### Pro Creator

- 月$12〜$25
- larger batches
- private/sealed evidence pointers
- custom verification page
- license templates

### Studio

- 月$99〜$299
- organization members
- delegated signing keys
- API and webhooks
- C2PA/VC integration
- audit export

### Enterprise

- annual contract
- dedicated shard / data residency controls
- SLA and incident support
- custom credential issuer
- legal workflow integration

### Transaction revenue

- license marketplace fee 2〜5%
- verified timestamp/credential issuance fee
- evidence vault storage/egress
- dispute review fee

## Unit economics

customerごとに次を追跡します。

```text
Gross margin
= subscription + transaction fees
- cycles
- storage/egress
- AI/API costs
- payment fees
- support and review cost
- security reserve
```

## Monetization experiments

1. 10 creatorsにmanual concierge verificationを提供
2. $19/monthのpreorderを提示
3. most valuable workflowを計測
4. blockchain自体ではなく、legal/export/client verification valueを販売
5. retentionが出るまでtokenを作らない
