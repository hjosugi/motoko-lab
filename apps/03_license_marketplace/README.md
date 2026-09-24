# App 03 — License Marketplace

proof record/hashに紐づくlicense listing、purchase submission、manual settlement、license grantを管理します。

## Payment: verified と manual

listingのpayment modeは作成時に決まります (`getPaymentMode`)。

- **`#verified`** (#12): controllerが`registerLedger`で登録したICRC-1 ledgerのlisting。canister自身がICRC-3 `icrc3_get_blocks`でblockを読み、送金先・送金者・金額・memo・時刻・未使用を確認してからgrantを発行します。buyerやsellerの申告ではgrantは出ません。
- **`#manual`**: #12以前のlisting、または未登録ledgerのlisting。buyerがledger principal・block index・receipt hashを提出し、sellerが確認します (sellerの判断を記録するだけで、transferは検証しません)。

`#verified` listingでは`submitPurchase`は拒否されます。forged receiptがgrantになる経路そのものを閉じるためです。設計・検査項目・retryの扱いは[docs/PAYMENTS.md](docs/PAYMENTS.md)にあります。

## Workflow (verified)

1. controller registers the ledger (`registerLedger`: symbol / decimals / fee are read from the ledger)
2. seller creates listing against it
3. buyer opens a payment intent (`openPurchase`): pay-to account, amount in base units, decimals, fee on top, 32-byte memo, 24h window
4. buyer transfers with `icrc1_transfer` and that memo
5. buyer confirms with the block index (`confirmPayment`); the ledger's answer issues the grant, and `getGrantPayment` shows the ledger's account of the payment

## Workflow (manual)

1. seller creates listing
2. buyer pays externally
3. buyer submits unique ledger+block receipt
4. seller accepts or rejects
5. accepted order creates immutable license grant

## Security properties

- anonymous writes rejected
- verified listings: a grant only from a ledger block that pays the seller, from the buyer, at least the price net of fee, with the intent memo, inside the intent window
- receipt replay blocked, across both flows (one `(ledger, block)` index)
- ledger failure is retry-safe; a repeated confirmation returns the same grant
- listing supply checked at settlement
- only seller can settle
- grant immutable
- bounded metadata and pagination

## Monetization

- marketplace take rate
- paid verification/credential issuance
- studio subscription

Do not deduct platform fee until actual ledger integration is audited. The verified flow pays the seller directly; fees, refunds and escrow are #13.
