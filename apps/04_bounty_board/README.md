# App 04 — Creator Bounty Board

creator/studioがbountyを公開し、contributorsがproof hash/URI付きsubmissionを出し、ownerがawardするworkflowです。

## Boundary

reward amountとledger principalを記録しますが、escrow/transferは実装していません。productionではICRC adapter、escrow funding proof、refund、disputeを追加します。

## Useful patterns

- status machine
- per-bounty/per-submitter duplicate prevention
- ownership authorization
- immutable award
- deadline and cancellation
- bounded pagination

## Monetization

- bounty posting fee
- escrow fee
- studio subscription
- verified contributor credential
