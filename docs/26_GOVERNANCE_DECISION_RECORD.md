# Governance and SNS-readiness decision record

Issue #40. Status: **accepted for the reference deployment; revisit at each gate
below.** Date: 2026-09-25.

Moving control to a DAO too early freezes unsafe policy behind a vote; moving
too late leaves every power in one key. This record decides what each phase
looks like, what may be governed, what an emergency may do, and what has to be
true before an SNS is even evaluated. It does not decide *that* an SNS will
happen.

## Decision

1. **Now (phase 0, reference / staging):** a single controller is acceptable
   only because nothing of value depends on these canisters yet. No mainnet
   deployment holds user funds or third-party evidence in phase 0 (#28 is the
   gate).
2. **Before any mainnet launch (phase 1):** controllers are a threshold of
   independent keys, never one; every privileged action and every module
   installation is logged where anyone can read it; emergency powers are
   narrower than normal ones and expire.
3. **SNS (phase 2)** is evaluated only after the go/no-go criteria below are
   met, and then decided as its own record. The default answer until then is
   no.

## Privileged actions

Every public method that only a privileged principal may call, per
application. The list is enforced: `scripts/check_privileged_actions.py`
scans every canister for methods gated on `isController`, app 06's
`requireOwner`/`isOwner`, or the worker's first-caller `controller`, including
gates reached through private helpers, and fails CI if a method is privileged
in code and missing here, or listed here and no longer privileged. A power
nobody wrote down is a power nobody decided about.

Beyond these methods, the **controllers of every canister** can install new
code, which is every power at once: `install_code` / upgrade, `stop_canister`,
`delete_canister`, changing the controller set, and `update_settings`
(freezing threshold, memory limits). That is the power this record is mostly
about.

| App | Method | Who | Power | Phase-1 class |
|---|---|---|---|---|
| `01_creator_proof_registry` | `addDisputeAuthority` | controller | decides which bodies' determinations are recorded (#8) | policy |
| `01_creator_proof_registry` | `retireDisputeAuthority` | controller | stops an authority recording new determinations | policy, emergency |
| `03_license_marketplace` | `registerLedger` | controller | which token ledgers are trusted to report payments (#12) | policy |
| `04_bounty_board` | `registerLedger` | controller | which ledgers escrow may use (#13) | policy |
| `04_bounty_board` | `setPlatform` | controller | the platform fee account and rate taken at settlement (#13) | treasury |
| `05_usage_metered_saas` | `createTenant` | controller | onboarding a tenant and its plan | operations |
| `05_usage_metered_saas` | `setTenantPlan` | controller | plan and price changes; closes the period pro rata (#14) | operations |
| `05_usage_metered_saas` | `setTenantEnabled` | controller | suspending a tenant | operations, emergency |
| `05_usage_metered_saas` | `setReporter` | controller | who may report usage | operations, emergency |
| `05_usage_metered_saas` | `setReporterPolicy` | controller | reporter scope and limits (#15) | operations |
| `05_usage_metered_saas` | `addReporterKey` | controller | device keys that may sign receipts (#15) | operations |
| `05_usage_metered_saas` | `retireReporterKey` | controller | key rotation | operations |
| `05_usage_metered_saas` | `markReporterKeyCompromised` | controller or the reporter | refusing everything a key signs | emergency |
| `05_usage_metered_saas` | `recordUsage` | controller or reporter | a controller can record usage for any tenant, unscoped | operations — see finding 2 |
| `05_usage_metered_saas` | `registerApiKeyHash` | tenant or controller | API key registration | operations |
| `05_usage_metered_saas` | `revokeApiKeyHash` | tenant or controller | API key revocation | operations, emergency |
| `05_usage_metered_saas` | `registerBillingLedger` | controller | which ledgers settle invoices (#14) | treasury |
| `05_usage_metered_saas` | `adjustInvoice` | controller | credit and debit notes (#14) | treasury |
| `05_usage_metered_saas` | `payInvoice` | tenant or controller | applying a verified ledger payment | operations |
| `05_usage_metered_saas` | `closePeriod` | tenant or controller | closing an ended billing period | operations |
| `05_usage_metered_saas` | `getInvoice` | tenant or controller | reading an invoice | read access |
| `05_usage_metered_saas` | `listInvoices` | tenant or controller | reading a tenant's invoices | read access |
| `05_usage_metered_saas` | `invoiceJson` | tenant or controller | exporting an invoice | read access |
| `06_distributed_llm` | `setWorkers` | owner | which worker canisters are trusted | policy |
| `06_distributed_llm` | `autoWire` | owner | wiring workers automatically | policy |
| `06_distributed_llm` | `setLlmCanister` | owner | which LLM canister is called | policy |
| `06_distributed_llm` | `setVerification` | owner | byzantine-detection strength (#44) | policy |
| `06_distributed_llm` | `setOpenAccess` | owner | opening the endpoints to everyone (#45) | policy, emergency |
| `06_distributed_llm` | `allow` | owner | allowlisting a caller | operations |
| `06_distributed_llm` | `revoke` | owner | removing a caller | operations, emergency |
| `06_distributed_llm` | `setQuota` | owner | per-principal budgets | operations |
| `06_distributed_llm` | `pruneQuotas` | owner | clearing quota state | operations |
| `06_distributed_llm` | `generate` | owner bypasses allowlist and quota | unmetered generation | operations |
| `06_distributed_llm` | `benchmark` | owner bypasses allowlist and quota | unmetered benchmarking | operations |
| `06_distributed_llm` | `askLlmCanister` | owner, for paid models | spending the canister's cycles on a paid model | treasury |
| `06_distributed_llm` | `configure` | first caller, then that caller | a worker's shard assignment | policy — see finding 1 |

What is **not** here matters as much. App 01 has no administrator over records:
revocation is the owner's, rotation and delegation the creator's, and disputes
are decided by authorities the registry only records (#7, #8). App 02 has no
privileged method. Apps 03 and 04 have no method that moves a buyer's or
hunter's money on a controller's say-so — payments and escrow are verified on
the ledger (#12, #13).

### Findings from building the inventory

1. **App 06 uses trust-on-first-use ownership.** The orchestrator's owner and
   each worker's controller are whoever calls a gated method first. That is
   fine on a replica and wrong anywhere else: a front-runner between
   installation and the first configuration call owns the canister. Phase 1
   requires the owner to be set by the install argument (or to be the
   canister's controller set) before app 06 is deployed anywhere public.
2. **App 05's controller can record usage for any tenant, outside every
   reporter policy.** Controllers are treated as operators, not reporters (#15).
   Phase 1 requires that every controller-recorded event is logged as such and
   that routine metering goes through a scoped reporter; the controller path is
   for corrections, which #14 already models better as adjustments.
3. **Controller-only is coarse.** In apps 01, 03, 04 and 05 "controller" means
   the replica's controller list, so whoever can upgrade the canister can also
   change any policy. Phase 1 keeps that — splitting them would need a second
   authority list with its own governance — but records it, because it means
   policy changes and code changes need the same threshold.

## Phase 1: threshold controllers and transparency

**Controllers.** Each production canister's controller set is a threshold
wallet or a canister governed by one (for example Orbit, or a purpose-built
multisig canister), **k-of-n with n ≥ 3, k ≥ 2, keys held by different people
on different hardware**, plus one blackhole-style monitoring canister that can
read status but not act. No individual developer key is a controller.

**Transparency requirements:**

- Every module installation is announced before it happens with the exact
  Wasm SHA-256, the git tag, and the reproducible-build command that produces
  it (#29 provides the reproducible build); after it happens, anyone can compare
  the announced hash with `canister_status.module_hash`. A module hash that
  does not match an announced release is an incident.
- Every privileged method call in the table above is logged, with the caller,
  the arguments and the time, to an append-only log readable by anyone —
  in the canister where the method lives, or in the threshold wallet's own
  proposal history. The dispute log (#8) is the pattern: hash-chained and
  certified.
- Release approvals — who approved which module hash, when — are kept with the
  release, next to the ZIP checksum this kit already publishes.
- Parameter changes take effect after a published delay (48 hours default), so
  users can see them coming; see emergencies for the exception.

## What may be governed

| Governable (by proposal, with delay) | Not governable (code change only, with release review) | Never governable |
|---|---|---|
| dispute authorities (#8) | the commitment layout, record digest, dispute event and receipt encodings (versioned by domain string) | rewriting, deleting or re-attributing an existing record, dispute event, receipt, invoice or payment |
| accepted ledgers and escrow platform fee/account (#12, #13) | the certified-data scheme (#6) | transferring a creator's identity outside its declared recovery (#7) |
| tenant plans, reporter scopes, keys (#14, #15) | abuse-control constants (rate windows, strike limits) — until they have been measured (#22) | moving buyers' or hunters' funds except by the verified flows |
| app 06 workers, verification strength, quotas | anything that changes a Candid type incompatibly (#17 gate) | |
| cycles top-up policy and alert thresholds (#24) | | |

The right-hand column is the point. Provenance is only evidence if nobody —
not a DAO, not a developer, not a majority of token holders — can edit what was
recorded. Anything in that column is enforced by the absence of a method, not
by a policy.

## Emergencies

An emergency power is **narrower than a normal one, faster, and temporary**:

- **What it may do:** pause write paths (stop accepting new commits, reveals,
  filings, receipts, payments); retire a dispute authority; mark a reporter key
  compromised; disable a tenant or reporter; revoke an app 06 caller. Every one
  of these only *withholds* service. None creates, edits or moves anything.
- **What it may not do:** install code, change controllers, change fees or
  plans, touch funds, or edit any record.
- **Who:** a smaller threshold than normal (for example 2-of-n instead of
  k-of-n), because a slow emergency is not one.
- **Bounds:** an emergency action expires after 72 hours unless ratified by the
  normal threshold, and every emergency action is reviewed in public within
  7 days (what happened, who acted, why, and what changes).
- **Upgrade veto:** a scheduled installation announced under phase-1
  transparency can be vetoed during its announcement delay by the normal
  threshold, or by the emergency threshold if the announced module hash does
  not match the reproducible build.

## SNS go/no-go criteria

An SNS is evaluated only when **all** of these hold, and even then decided in
its own record:

| Criterion | Why | Depends on |
|---|---|---|
| an independent security audit is complete and its findings are remediated | a DAO makes fixing a flaw slower, so find the flaws first | #21 |
| a reproducible mainnet release process has shipped at least three releases | the SNS will vote on module hashes; they have to be checkable | #28, #29 |
| intellectual-property, terms and claims review is complete | a DAO inherits whatever the product promises | #35 |
| privacy review is complete | governance proposals are public; data must not need to be | #20 |
| twelve months of mainnet operation with published incidents, SLIs and cycle runway | a treasury needs a history to budget from | #24, #25 |
| revenue covers operating cost without token sales | a DAO whose treasury is its own token is paying itself | #36 |
| a concrete list of decisions users want to make that a threshold wallet cannot make legitimately | an SNS is a means; without a governance need it is overhead | — |

**No-go signals** that stop the evaluation: a single party would hold a voting
majority; the proposal would put any "never governable" item up for vote; the
treasury's main asset would be the governance token; or emergency response
would depend on a vote.

## Test plan (tabletop)

| Scenario | Expected response under this record |
|---|---|
| **Key compromise** — one threshold key is stolen | k ≥ 2 means the thief alone can do nothing. The remaining holders rotate the compromised key out of the threshold wallet; no canister's controller set changes, because the wallet is the controller. If the stolen key belonged to a reporter device, `markReporterKeyCompromised` refuses everything it signs, whatever time it claims (#15). |
| **Malicious proposal** — a proposal would add an authority that rubber-stamps "upheld", or re-route the escrow platform fee | The 48-hour delay makes it visible; the privileged-action log shows exactly which call is proposed. An authority's determinations never change a record (#8), so the damage of a bad authority is bounded to statements a reader can discount; retiring it is an emergency action. Re-routing funds already in escrow is not possible: settlement pays the recorded winner and fee (#13). |
| **Slow emergency vote** — an exploit is live and the normal threshold cannot convene | The emergency threshold pauses the affected write path. It cannot upgrade; the fix goes through a normal release, vetoable if its hash is wrong. The pause expires in 72 hours unless ratified, so a stuck emergency cannot become permanent. |
| **Treasury conflict** — holders want fees raised to fund themselves; users want them lowered | Fees are governable with delay and published; existing escrows and invoices keep the terms they were created under (#13, #14), so a change never applies retroactively. The SNS criteria require revenue to cover costs *before* a token exists, so the treasury is not the product's reason to be. |

## Consequences

- `scripts/check_privileged_actions.py` runs in CI; adding a privileged method
  now requires adding it here, with its class.
- Findings 1 and 2 are phase-1 blockers for app 06 and app 05 respectively.
- #21, #28, #29, #35, #20, #24, #25 and #36 are inputs to the SNS decision;
  this record does not pretend to satisfy them.
