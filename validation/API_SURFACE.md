# Motoko / Candid API Surface Check

Status: **PASS**

Checked: public method names, query/update modes, and top-level argument counts.
This is an offline guardrail and does not replace compiler-generated Candid or upgrade compatibility checks.

| App | Methods | Status |
|---|---:|---|
| `01_creator_proof_registry` | 9 | PASS |
| `02_merkle_anchor` | 6 | PASS |
| `03_license_marketplace` | 10 | PASS |
| `04_bounty_board` | 9 | PASS |
| `05_usage_metered_saas` | 12 | PASS |

## Per-application methods

### 01_creator_proof_registry

- `cancelCommitment`: update, 1 argument(s)
- `commit`: update, 1 argument(s)
- `getByArtifactHash`: query, 1 argument(s)
- `getCommitment`: query, 1 argument(s)
- `getRecord`: query, 1 argument(s)
- `listRecords`: query, 2 argument(s)
- `reveal`: update, 1 argument(s)
- `revokeRecord`: update, 2 argument(s)
- `stats`: query, 0 argument(s)

### 02_merkle_anchor

- `anchor`: update, 1 argument(s)
- `getBatch`: query, 1 argument(s)
- `getByRoot`: query, 1 argument(s)
- `listBatches`: query, 2 argument(s)
- `revoke`: update, 2 argument(s)
- `stats`: query, 0 argument(s)

### 03_license_marketplace

- `acceptPurchase`: update, 1 argument(s)
- `createListing`: update, 1 argument(s)
- `getGrant`: query, 1 argument(s)
- `getListing`: query, 1 argument(s)
- `getOrder`: query, 1 argument(s)
- `listListings`: query, 2 argument(s)
- `rejectPurchase`: update, 2 argument(s)
- `setListingActive`: update, 2 argument(s)
- `stats`: query, 0 argument(s)
- `submitPurchase`: update, 1 argument(s)

### 04_bounty_board

- `award`: update, 2 argument(s)
- `cancelBounty`: update, 2 argument(s)
- `createBounty`: update, 1 argument(s)
- `getAward`: query, 1 argument(s)
- `getBounty`: query, 1 argument(s)
- `getSubmission`: query, 1 argument(s)
- `listBounties`: query, 2 argument(s)
- `stats`: query, 0 argument(s)
- `submit`: update, 1 argument(s)

### 05_usage_metered_saas

- `createTenant`: update, 1 argument(s)
- `getApiKey`: query, 1 argument(s)
- `getTenant`: query, 1 argument(s)
- `getUsageEvent`: query, 1 argument(s)
- `listUsageEvents`: query, 2 argument(s)
- `recordUsage`: update, 1 argument(s)
- `registerApiKeyHash`: update, 3 argument(s)
- `revokeApiKeyHash`: update, 1 argument(s)
- `setReporter`: update, 2 argument(s)
- `setTenantEnabled`: update, 2 argument(s)
- `setTenantPlan`: update, 2 argument(s)
- `stats`: query, 0 argument(s)
