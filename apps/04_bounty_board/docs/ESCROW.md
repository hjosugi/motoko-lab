# ICRC-2 escrow

Issue #13. The bounty board used to record a reward and a ledger principal and
leave the money to the owner's good faith. An award was a promise. Now a
bounty posted against a registered ledger is **escrowed**: the reward sits in
a subaccount the board controls before anyone can enter or win, and it leaves
only to the winner, the platform or back to the owner.

The flow is ICRC-2's approve / transfer-from for funding, and ICRC-1 transfers
for payouts and refunds. Every ledger call goes through `backend/src/Ledger.mo`.
Every amount comes from `backend/src/Escrow.mo`.

## The flow

1. A **controller** registers the ledger (`registerLedger`, which reads symbol,
   decimals and fee from the ledger) and optionally sets the platform's account
   and rate (`setPlatform`, capped at 20%).
2. The owner posts a bounty against that ledger. The terms are fixed at that
   point and never change afterwards: the rate is a snapshot, so a later
   `setPlatform` rewrites no posted bounty.

   ```text
   platformFee = reward × feeBps / 10 000
   deposit     = reward + fee                         (no platform cut)
               = reward + fee + platformFee + fee     (with one)
   approval    = deposit + fee                        (transfer_from charges its own fee)
   ```

3. The owner calls `icrc2_approve` on the ledger, with this canister as spender
   for `approval` and optionally an expiry. Then the owner calls
   `fundEscrow(bountyId)`, and the board pulls `deposit` into the bounty's own
   subaccount: 32 bytes, the bounty id big-endian. Until that succeeds,
   `submit` and `award` refuse the bounty.
4. `award` records the award first, then pays the winner `reward` and the
   platform `platformFee`, each paying one ledger fee out of the deposit.
5. `cancelBounty` on a funded bounty refunds everything to the owner, less the
   fee of the refund itself. On an unfunded bounty it just closes it
   (`#closedUnfunded`).
6. `settleEscrow(bountyId)` finishes whatever is left: a transfer whose outcome
   is unknown, or a payout or refund the ledger could not take when it was
   first tried. Anyone may call it, because it only moves money to
   destinations the bounty already fixed.

`getEscrow` shows the terms, the state (`#awaitingFunds`, `#funded`,
`#releasing`, `#released`, `#refunding`, `#refunded`, `#closedUnfunded`), and
the log of every ledger operation, including the refused ones.

## Idempotency

Every transfer is fixed before its first attempt: amount, fee, memo
(`bounty:<id>:fund|winner|platform|refund`) and `created_at_time`. The adapter
reduces each ledger answer to one of five outcomes, and each outcome allows
exactly one next step:

| Outcome | Ledger answer | Next step |
|-|-|-|
| executed | `Ok(block)`, or `Duplicate { duplicate_of }` | record the block and plan the next transfer |
| refused | `InsufficientAllowance`, `InsufficientFunds`, `GenericError`, … | the transfer did not happen. Mark it failed; a new one may replace it |
| bad fee | `BadFee { expected_fee }` | did not happen. Redo the arithmetic at the new fee (below) |
| unknown | the call rejected, trapped or timed out; `TemporarilyUnavailable` | **the identical call again**. Nothing else is safe |
| stale | `TooOld` on that identical retry | the dedup window closed. Decide from the escrow balance (below) |

The ICRC-1 ledger deduplicates transactions that carry `created_at_time` for
24 hours. An identical retry of a transfer that did happen returns `Duplicate`
with the original block instead of executing again. That turns "the reply was
lost" into a solvable problem. Arguments change only after a **definitive**
refusal: changing them after an unknown outcome would make the ledger treat the
retry as a new transfer, and pay twice.

**After the dedup window.** A retry more than 24 hours later gets `TooOld`, and
the ledger can no longer say whether the first attempt happened. The escrow
subaccount belongs to this bounty alone, so only this bounty's transfers move
its balance, and the balance answers the question. The books say what the
subaccount holds before the operation, and the operation either explains the
observed balance or it does not. Such an operation is recorded as done with no
block to cite.

**Concurrency.** A second `settleEscrow` can run while the first waits for the
ledger. Both send the same arguments, the ledger deduplicates, and the escrow
re-reads its state after every `await`: an operation already settled by the
other caller is left alone. `award` records the award before any money moves,
so a second award sees a closed bounty whatever the ledger does meanwhile.

## Fee changes

- **Before funding.** The pull fails with `BadFee`. The escrow recomputes
  `deposit` at the new fee, returns `#feeChanged { fee, deposit, approval }`,
  and the owner approves the new amount.
- **After funding.** The winner is paid first and **in full** as long as the
  deposit covers `reward` plus one fee. The platform's share absorbs the
  difference; if what is left does not exceed a fee, no platform transfer is
  made and the remainder stays as dust. The replica suite raises the fee from
  20,000 to 30,000 between funding and award: the winner receives exactly the
  reward and the platform `cut − 2 × 10,000`.
- **Either way,** a `BadFee` updates the registered fee, so bounties posted
  afterwards are priced at the fee the ledger actually charges.

## The accounting invariant

For every split:

```text
winner + platform + fees of transfers made + dust = deposit,    dust ≤ fee
```

`test/Escrow.test.mo` checks it for 576 combinations: 6 rewards, 4 rates,
4 funding fees and 6 payout fees. It also checks that at the funding fee the
winner gets exactly the reward, the platform exactly its cut, and nothing is
left. The replica suite checks the same books against the ledger: after every
scenario, for all eight escrows, the escrow subaccount's balance on the ledger
equals the balance the op log implies. Owner, winner and platform balances move
by exactly the expected amounts.

## Test plan, as run (pocket-ic 14.0.0, `test/fixtures/MockLedger.mo`)

The mock implements ICRC-1/ICRC-2 the way the reference ledger does: fees on
top, allowances with expiry, deduplication checked before anything else, and
`TooOld` after 24 hours. It adds test controls to change the fee, to make
transfers trap, and to execute a transfer and then **drop its reply** (a Motoko
`throw` commits state, unlike a trap).

- **Allowance expires.** Approved for an hour, used after two: refused as an
  insufficient allowance, and the escrow stays unfunded.
- **Fee changes.** Before funding the owner gets `#feeChanged` with the new
  approval. At payout the winner is paid in full and the platform absorbs it.
- **Insufficient funds.** Refused, and the escrow stays unfunded.
- **Duplicate callback.** The pull executes and its reply is lost. The books
  say pending while the money has moved, and the identical retry is
  deduplicated into the original block, so the owner is charged once. The same
  happens to the winner's payout, and the winner is paid exactly once.
- Also covered: funding without an approval, a ledger down at award time with
  settlement after it recovers, refunding a funded bounty, cancelling while a
  pull's outcome is unknown (the pull is resolved first, then refunded),
  closing an unfunded bounty, `TooOld` reconciled from the balance, repeated
  settlement moving nothing, and all of it surviving an upgrade.

## Not in scope

- **Disputes over an award.** The owner still decides who wins; the escrow only
  guarantees the reward exists and goes where the award says. The registry's
  dispute workflow (#8) is about provenance records, not bounty awards.
- **Partial awards and multiple winners.** One winner, one reward.
- **Mainnet ledgers.** The adapter uses only standard ICRC-1/ICRC-2 methods,
  but it has not run against the ICP ledger or ckBTC.
- **The license marketplace's `#paidSoldOut` refunds (#12).** The same adapter
  would carry them. The marketplace does not hold the buyer's payment in
  escrow (it goes straight to the seller), so a refund there needs the seller,
  not the canister.
