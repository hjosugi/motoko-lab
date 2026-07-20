# App 03 — License Marketplace

proof record/hashに紐づくlicense listing、purchase submission、manual settlement、license grantを管理します。

## Important boundary

このreferenceはledger transferを自動検証しません。buyerがledger principal、block index、receipt hashを提出し、sellerが確認します。productionではICRC-1/2 adapterとblock verificationを追加してください。

## Workflow

1. seller creates listing
2. buyer pays externally
3. buyer submits unique ledger+block receipt
4. seller accepts or rejects
5. accepted order creates immutable license grant

## Security properties

- anonymous writes rejected
- receipt replay blocked
- listing supply checked at settlement
- only seller can settle
- grant immutable
- bounded metadata and pagination

## Monetization

- marketplace take rate
- paid verification/credential issuance
- studio subscription

Do not deduct platform fee until actual ledger integration is audited.
