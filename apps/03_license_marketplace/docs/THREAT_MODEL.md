# Threat Model

- manual listings: the seller can falsely accept an unverified payment; the canister records the seller's word. `getGrantPayment` is `null` for such grants, so a verifier can tell them apart
- verified listings (#12, docs/PAYMENTS.md): a forged receipt cannot create a grant. The buyer supplies only a block index; recipient, payer, amount, memo and time are read from the ledger, and `submitPurchase` is refused
- someone else's payment: rejected by the payer check even when it carries the right memo
- cross-marketplace replay: the intent memo is bound to the marketplace principal and the intent id; dedup alone is per canister
- pre-paid / predicted memo: rejected by the intent time window (block ts before the intent opened, minus 5 min skew)
- receipt replay is blocked by ledger+block index, shared between the manual and verified flows
- reentrancy: `confirmPayment` re-reads intent status, the block index and supply after the ledger call; no await between those reads and the grant write
- a malicious ledger: only controller-registered ledgers are asked, and their archive callbacks are trusted to the same degree
- price/terms are immutable after listing; create a new listing for changes
- proof record status must be checked at purchase/settlement in production
- refunds, chargebacks, ledger forks, fees, decimals, token allowlist require explicit policy
