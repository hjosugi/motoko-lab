# App 04 — Creator Bounty Board

creator/studioがbountyを公開し、contributorsがproof hash/URI付きsubmissionを出し、ownerがawardするworkflowです。

## Escrow (#13)

controllerが`registerLedger`したledgerで作ったbountyは**escrow必須**です。ownerがICRC-2 `icrc2_approve`でこのcanisterを承認し、`fundEscrow`でbounty専用subaccountへdepositを引き込むまで、`submit`も`award`も拒否されます。`award`でwinnerへreward、platformへcutを送金し、funded後の`cancelBounty`はownerへ返金します。

- depositはreward + (platform cut) + 送金ごとのledger fee。termsはbounty作成時に固定 (platform rateはsnapshot)
- 全transferは金額・fee・memo・`created_at_time`を最初の試行前に確定し、結果不明ならledgerのdeduplicationに任せて**同一引数で**再試行します。`Duplicate`は成功として扱い、`TooOld`後はescrow subaccountの残高で判定します
- ledger feeが上がってもwinnerは満額で、差額はplatform側が吸収します
- `settleEscrow`は誰でも呼べ、固定済みの宛先にしかお金を動かしません

登録していないledgerのbountyは従来どおりescrowなし (rewardとledgerの記録のみ) です。設計・状態遷移・会計不変条件は[docs/ESCROW.md](docs/ESCROW.md)。

## Useful patterns

- status machine
- per-bounty/per-submitter duplicate prevention
- ownership authorization
- immutable award
- escrowed reward: no entry, no award until funded; idempotent payout and refund
- deadline and cancellation
- bounded pagination

## Monetization

- bounty posting fee
- escrow fee
- studio subscription
- verified contributor credential
