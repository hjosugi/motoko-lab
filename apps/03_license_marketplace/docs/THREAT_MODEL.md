# Threat Model

- seller can falsely accept unverified payment in this reference; production adapter must verify ledger block
- receipt replay is blocked by ledger+block index
- price/terms are immutable after listing; create a new listing for changes
- proof record status must be checked at purchase/settlement in production
- refunds, chargebacks, ledger forks, fees, decimals, token allowlist require explicit policy
