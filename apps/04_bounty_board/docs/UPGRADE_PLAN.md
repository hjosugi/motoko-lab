# Upgrade Plan

Preserve closed bounty and award records. Escrow integration must be additive with explicit funding/settlement states and idempotent transfer IDs.

## Escrow (#13)

- Stable data: side tables only (`ledgers`, `platform`, `escrows`). `Bounty` and `Award` are unchanged, so no migration.
- Bounties posted before the upgrade have no escrow entry and behave exactly as before; registering a ledger does not escrow an existing bounty.
- An escrow's op log is the source of truth for idempotency: an upgrade in the middle of a transfer with an unknown outcome keeps the op `#pending` with its original `created_at_time`, and `settleEscrow` after the upgrade retries it identically. The replica suite upgrades with released, refunded and funded escrows and checks settlement moves nothing twice.
- Candid: new methods and types only; `award` and `cancelBounty` keep their signatures and return the old `Error`.
