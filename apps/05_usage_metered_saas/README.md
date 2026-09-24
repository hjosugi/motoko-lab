# App 05 — Usage-Metered SaaS

Motoko canisterをSaaS control planeとして使うreferenceです。tenant、plan、quota period、hashed API key、authorized reporter、idempotent usage eventを管理します。

## Security model

- controller creates/changes tenants and reporters
- tenant or controller registers/revokes API key hashes
- reporter/controller records usage
- reporters can be scoped (tenants, categories, units per event and per window) and required to sign
- signed usage receipts: P-256 device keys registered by a controller, verified on-chain, replay-safe (`docs/RECEIPTS.md`)
- raw API key is never stored
- idempotency key is scoped to tenant
- quota is enforced before event append

## Important boundary

API key verification gatewayはoff-chainです。invoiceと支払い検証はcanister内にあり (`docs/BILLING.md`)、支払いそのものはICRC-1 ledgerで行います。canisterへraw keyを送らず、cryptographic hashを送ります。

## Signed receipts

`submitReceipts`はreporterが自分の名前で署名済みreceiptを最大16件まとめて提出するendpointです (#15)。receiptはusageを観測した場所 (gateway、device、offline batch) でP-256鍵により署名され、canisterはreporter principal (callを認証) と署名鍵 (receiptを認証) の両方を要求します。片方だけ盗まれても請求は偽造できません。reporterごとのpolicy (tenant・category・1件あたり・window単位の上限、`requireSignatures`)、鍵のrotation / compromise、clock skewとreplayの規則、`getReporter`のhealth (anomaly flag)、`exportUsageAudit`による第三者検証は`docs/RECEIPTS.md`を参照してください。検証1件あたり約0.7B cycles (pocket-icで測定) なので、receiptは1 requestではなく集計したusageを載せる前提です。

## Billing

billing period・invoice・payment・adjustmentを持ちます (#14)。periodはplanの境界に揃い、一度だけcloseされ (rollover時・`closePeriod`・plan変更時)、invoiceはplanのsnapshot・対象期間・全usage event idを持つ不変の記録です。支払いはICRC-1 transferのblockをledgerから読んで検証し (#12と同じICRC-3 adapter)、同じblockは一度しか適用されません。返金やservice creditは`adjustInvoice`で別レコードとして追記し、invoice自体は書き換えません。締めた後に届いたreceiptは次の期間に計上され`lateEvents`として記録されます。`invoiceJson`は顧客向けのJSONです。詳細は`docs/BILLING.md`。

## Monetization use

- API calls
- provenance verification
- batch anchoring
- organization seats
- evidence storage

## Production gaps

- delegated organization admin
- key prefix/rotation UX
- certified usage export
- rate limiting by cycles/economic stake
