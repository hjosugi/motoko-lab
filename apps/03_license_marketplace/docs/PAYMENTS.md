# Ledger-verified payment (ICRC-1 / ICRC-3)

Issue #12. Before this, a buyer submitted `(ledger, block, receiptHash)` and the
seller decided whether to believe it. The canister deduplicated the claim and
recorded the seller's decision, but it never saw a transfer. A seller who
trusted a forged receipt issued a real licence for it.

Now a listing can take payment the canister verifies itself. A grant is issued
because the **ledger** says money moved. It is never issued on the buyer's or
the seller's word.

## The flow

1. A **controller** registers a ledger: `registerLedger(ledger)`. The canister
   reads `icrc1_symbol`, `icrc1_decimals` and `icrc1_fee` from the ledger and
   stores them. Which tokens the marketplace accepts is operator policy, and a
   registered ledger is trusted to report its own history.
2. The seller creates a listing whose `currencyLedger` is registered. Its
   payment mode is fixed as `#verified` at that moment (`getPaymentMode`).
   Listings created earlier, or against an unregistered ledger, stay `#manual`
   and keep the old flow.
3. The buyer calls `openPurchase(listingId)` and receives a **payment intent**:
   who to pay (`payTo`, the seller's default account), `amount` in base units
   with `decimals` and `symbol` beside it, the ledger `fee` the buyer pays on
   top, a 32-byte `memo`, and `expiresAt` (24 hours).
4. The buyer makes an ordinary ICRC-1 `icrc1_transfer` with that memo.
5. The buyer calls `confirmPayment(intentId, blockIndex)`. The canister fetches
   the block with ICRC-3 `icrc3_get_blocks`, following an archive callback if
   the block has been archived. If every check below passes it issues the grant,
   together with an order like the one the manual flow produces, and records the
   ledger's account of the payment (`getGrantPayment`).

On a `#verified` listing, `submitPurchase` is refused. The manual flow is the
path a forged receipt takes to a grant, so a listing whose ledger can be asked
does not offer it.

## What the block has to say

The buyer supplies only a block index, which is a pointer. Every property of
the payment is read from the ledger:

| Check | Rule | Why |
|-|-|-|
| type | `btype = "1xfer"`, or `tx.op = "xfer"` on ledgers that predate `btype` | mints, burns, approvals and ICRC-2 transfer-froms are not payments |
| to | the intent's `payTo`, with ICRC-1 subaccount normalization | `[owner]` and `[owner, 0x00×32]` are the same account; anything else is not |
| from | the buyer who opened the intent, any subaccount | someone else's payment carrying the right memo is still someone else's |
| amount | `amt ≥ amount`; overpayment accepted and recorded | the fee is paid on top. A buyer who counted it inside the price underpaid by exactly the fee, and that is refused |
| memo | equal to the intent memo | binds the payment to one intent on one marketplace (below) |
| time | block `ts` within `[createdAt − 5 min, expiresAt]` | a payment made before the intent existed, or after it lapsed, is not a payment for it |
| uniqueness | `(ledger, block)` unused | one payment, one grant. The index is shared with the manual flow, so neither flow can re-spend a block the other used |

### The memo

```text
memo = SHA-256( "icp-license-intent:v1" || 0x00 || marketplace principal bytes || 0x00 || intent id, 8 bytes big-endian )
```

That is 32 bytes, the ICRC-1 default maximum. The marketplace principal is in
it because `(ledger, block)` deduplication only covers one canister. Without
it, a single payment memo saying "intent 7" could be claimed as intent 7 on
every marketplace deployment that pays the same seller. Intent ids are
predictable, so the memo alone is not enough, which is why the time window
exists. The replica suite pays with the memo of an intent that has not been
opened yet and checks that the payment is refused.

## Outcomes and retries

`confirmPayment` returns `PaymentError`, a new type. Adding tags to the
existing `Error` would change the result of every existing method, and
Candid's special `opt` rule would let released clients read the new tags as
`null`.

| Result | Meaning | What to do |
|-|-|-|
| `#ok(grant)` | verified, grant issued | — |
| `#err(#rejected(reason))` | the ledger answered, and the block is not a payment for this intent | submit the right block. The rejection is kept in `rejections` for audit and **does not close the intent** |
| `#err(#ledgerUnavailable(_))` | the ledger could not be asked (reject, trap or timeout) | repeat the same call. Nothing was recorded |
| `#err(#duplicate(_))` | the block already paid for something | — |
| `#err(#soldOut)` | the payment verified, but the listing sold out between intent and confirmation | the intent is `#paidSoldOut` and the block is consumed. A refund is owed; see "Not in scope" |

**Repeating is always safe.** If a call issued the grant but its response was
lost, repeating the same `(intent, block)` returns the same grant and issues
nothing new. This is the "timeout after success" case in the test plan, and
the suite runs it before and after an upgrade.

**Everything is re-checked after the ledger call.** Other messages run while
`confirmPayment` waits for the ledger: a concurrent confirmation of the same
block, or a sale that uses up the supply. Checks made before the `await`
describe a state that may no longer exist. So the intent status, the
`(ledger, block)` index and the supply are read again when the answer arrives,
and the grant is written in the same message as those reads, with no `await`
in between.

## Decimals and fees

`price` on a listing has always been in the ledger's base units. The intent
now puts `decimals` and `symbol` next to `amount`, so no client has to guess
what "1000000" means. The `fee` is the ledger's fee when the intent opened.
The buyer pays it in addition to `amount`. The verified payment records the
effective fee from the block: `tx.fee` when the sender named one, the
block-level `fee` otherwise.

## The adapter

- `backend/src/Icrc3.mo` holds the ICRC-1 account and ICRC-3 block types,
  subaccount normalization, and decoding of a transfer from the generic `Value`
  form. It is pure. The `Ledger` actor type contains only the four standard
  methods the adapter calls (`icrc1_symbol`, `icrc1_decimals`, `icrc1_fee`,
  `icrc3_get_blocks`), so no method specific to one ledger appears: the ICP
  ledger, ckBTC, ckETH and SNS ledgers all implement them.
- `backend/src/Payment.mo` contains the rules above (pure) and `fetchBlock`,
  the one async function. It catches every failure of the call and turns it
  into `#unavailable`, so nothing traps the caller.

`test/Payment.test.mo` covers every block shape in the interpreter, including
ones a transfer never produces: the legacy `tx.op` form, fees at both levels,
mints, approvals, transfer-froms, 30-byte principals, short subaccounts, and
wrongly typed fields. `test/fixtures/MockLedger.mo` is a local ICRC-1/ICRC-3
ledger with balances, fees and an archive callback. The replica suite makes
real transfers on it.

## Test plan, as run (pocket-ic 14.0.0)

- **Wrong recipient**: paid to a stranger, and paid to a non-zero seller
  subaccount (interpreter). Both rejected.
- **Underpayment**: paid `price − fee`. Rejected with "the payment is less than
  the price".
- **Duplicate block**: the block that paid one intent is refused for a second
  intent, and through the manual flow of a listing on the same ledger, before
  and after an upgrade.
- **Timeout after success**: repeating a successful confirmation returns the
  same grant, and the grant count does not move.
- Also: someone else's payment carrying the right memo, a missing memo, a mint,
  an ICRC-2 `2xfer` block, a nonexistent index, a payment made before the
  intent opened, a payment made after it expired, a block served from the
  archive, a ledger that rejects the call (then succeeds on retry), selling out
  between payment and confirmation, and a registration attempt against a
  canister that is not a ledger.

## Not in scope

- **Refunds.** `#paidSoldOut` records a verified payment that is owed back,
  and the canister does not move funds. Refund and escrow, including platform
  fees and ICRC-2 transfer-from, are #13. `apps/04_bounty_board`'s reward is an
  escrow flow for the same reason and is left to #13.
- **Mainnet ledgers.** Nothing here has run against the ICP ledger or ckBTC.
  The adapter only uses the standard ICRC-1/ICRC-3 methods, but the first
  mainnet run is a release gate of its own.
- **ICRC-3 block hashes.** The canister trusts a registered ledger's answer to
  an inter-canister call, which runs under consensus. It does not check
  `phash` chains or ICRC-3 certificates. That becomes relevant if blocks are
  ever fetched through a third party instead of from the ledger.
