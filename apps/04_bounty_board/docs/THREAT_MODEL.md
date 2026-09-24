# Threat Model

- reward is escrowed for bounties on registered ledgers (#13, docs/ESCROW.md): no entry or award until the deposit is in the bounty's subaccount; unregistered-ledger bounties keep the old record-only behaviour
- double payment on retry: every transfer is retried with identical arguments and the ledger deduplicates; arguments change only after a definitive refusal
- lost replies: an executed transfer whose reply is lost is recovered as `Duplicate`, or, after the 24-hour dedup window, from the escrow subaccount balance
- over-pulling: a pull with an unknown outcome is always repeated, never replaced, so an over-sized approval cannot be pulled twice
- fee changes: before funding the owner re-approves; after funding the winner is paid in full and the platform absorbs the difference
- `settleEscrow` is callable by anyone but only moves money to the destinations the bounty fixed
- a malicious ledger: only controller-registered ledgers are used
- owner may award dishonestly; public criteria hash and dispute policy reduce ambiguity
- one submission per principal/bounty prevents spam but may be too restrictive
- proof canister status must be independently verified
- deadline uses canister time; legal deadline wording needs tolerance
