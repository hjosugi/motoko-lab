# Motoko / Candid API Surface Check

Status: **PASS**

Checked: public method names, query/update modes, and top-level argument counts.
This is an offline guardrail and does not replace compiler-generated Candid or upgrade compatibility checks.

| App | Methods | Status |
|---|---:|---|
| `01_creator_proof_registry` | 39 | PASS |
| `02_merkle_anchor` | 9 | PASS |
| `03_license_marketplace` | 17 | PASS |
| `04_bounty_board` | 16 | PASS |
| `05_usage_metered_saas` | 27 | PASS |
| `06_distributed_llm` | 17 | PASS |

## Per-application methods

### 01_creator_proof_registry

- `addDisputeAuthority`: update, 3 argument(s)
- `addDisputeEvidence`: update, 2 argument(s)
- `appealDispute`: update, 2 argument(s)
- `attribution`: query, 1 argument(s)
- `beginRecovery`: update, 2 argument(s)
- `cancelCommitment`: update, 1 argument(s)
- `cancelRecovery`: update, 1 argument(s)
- `commit`: update, 1 argument(s)
- `commitmentSpec`: query, 0 argument(s)
- `confirmRecovery`: update, 1 argument(s)
- `createCollection`: update, 1 argument(s)
- `createDelegation`: update, 3 argument(s)
- `declareRecovery`: update, 2 argument(s)
- `determineDispute`: update, 2 argument(s)
- `disputeEvents`: query, 1 argument(s)
- `disputeSummary`: query, 1 argument(s)
- `exportDispute`: query, 1 argument(s)
- `fileDispute`: update, 1 argument(s)
- `getByArtifactHash`: query, 1 argument(s)
- `getCollection`: query, 1 argument(s)
- `getCommitment`: query, 1 argument(s)
- `getCreator`: query, 1 argument(s)
- `getDelegation`: query, 1 argument(s)
- `getDispute`: query, 1 argument(s)
- `getRecord`: query, 1 argument(s)
- `getRecordCertified`: query, 1 argument(s)
- `getRecovery`: query, 1 argument(s)
- `listDisputeAuthorities`: query, 0 argument(s)
- `listDisputes`: query, 3 argument(s)
- `listRecords`: query, 2 argument(s)
- `registerCreator`: update, 0 argument(s)
- `respondToDispute`: update, 2 argument(s)
- `retireDisputeAuthority`: update, 1 argument(s)
- `reveal`: update, 1 argument(s)
- `revokeDelegation`: update, 2 argument(s)
- `revokeRecord`: update, 2 argument(s)
- `rotateKey`: update, 2 argument(s)
- `stats`: query, 0 argument(s)
- `withdrawDispute`: update, 2 argument(s)

### 02_merkle_anchor

- `anchor`: update, 1 argument(s)
- `getBatch`: query, 1 argument(s)
- `getByRoot`: query, 1 argument(s)
- `listBatches`: query, 2 argument(s)
- `merkleSpec`: query, 0 argument(s)
- `revoke`: update, 2 argument(s)
- `stats`: query, 0 argument(s)
- `verifyMultiproof`: query, 2 argument(s)
- `verifyProof`: query, 2 argument(s)

### 03_license_marketplace

- `acceptPurchase`: update, 1 argument(s)
- `confirmPayment`: update, 2 argument(s)
- `createListing`: update, 1 argument(s)
- `getGrant`: query, 1 argument(s)
- `getGrantPayment`: query, 1 argument(s)
- `getIntent`: query, 1 argument(s)
- `getLedger`: query, 1 argument(s)
- `getListing`: query, 1 argument(s)
- `getOrder`: query, 1 argument(s)
- `getPaymentMode`: query, 1 argument(s)
- `listListings`: query, 2 argument(s)
- `openPurchase`: update, 1 argument(s)
- `registerLedger`: update, 1 argument(s)
- `rejectPurchase`: update, 2 argument(s)
- `setListingActive`: update, 2 argument(s)
- `stats`: query, 0 argument(s)
- `submitPurchase`: update, 1 argument(s)

### 04_bounty_board

- `award`: update, 2 argument(s)
- `cancelBounty`: update, 2 argument(s)
- `createBounty`: update, 1 argument(s)
- `fundEscrow`: update, 1 argument(s)
- `getAward`: query, 1 argument(s)
- `getBounty`: query, 1 argument(s)
- `getEscrow`: query, 1 argument(s)
- `getLedger`: query, 1 argument(s)
- `getPlatform`: query, 0 argument(s)
- `getSubmission`: query, 1 argument(s)
- `listBounties`: query, 2 argument(s)
- `registerLedger`: update, 1 argument(s)
- `setPlatform`: update, 2 argument(s)
- `settleEscrow`: update, 1 argument(s)
- `stats`: query, 0 argument(s)
- `submit`: update, 1 argument(s)

### 05_usage_metered_saas

- `addReporterKey`: update, 2 argument(s)
- `adjustInvoice`: update, 2 argument(s)
- `closePeriod`: update, 1 argument(s)
- `createTenant`: update, 1 argument(s)
- `exportUsageAudit`: query, 2 argument(s)
- `getApiKey`: query, 1 argument(s)
- `getInvoice`: query, 1 argument(s)
- `getReporter`: query, 1 argument(s)
- `getTenant`: query, 1 argument(s)
- `getUsageEvent`: query, 1 argument(s)
- `invoiceJson`: query, 1 argument(s)
- `listInvoices`: query, 1 argument(s)
- `listUsageEvents`: query, 2 argument(s)
- `markReporterKeyCompromised`: update, 1 argument(s)
- `payInvoice`: update, 3 argument(s)
- `receiptSpec`: query, 0 argument(s)
- `recordUsage`: update, 1 argument(s)
- `registerApiKeyHash`: update, 3 argument(s)
- `registerBillingLedger`: update, 1 argument(s)
- `retireReporterKey`: update, 1 argument(s)
- `revokeApiKeyHash`: update, 1 argument(s)
- `setReporter`: update, 2 argument(s)
- `setReporterPolicy`: update, 2 argument(s)
- `setTenantEnabled`: update, 2 argument(s)
- `setTenantPlan`: update, 2 argument(s)
- `stats`: query, 0 argument(s)
- `submitReceipts`: update, 1 argument(s)

### 06_distributed_llm

- `access`: query, 0 argument(s)
- `allow`: update, 1 argument(s)
- `askLlmCanister`: update, 2 argument(s)
- `autoWire`: update, 0 argument(s)
- `benchmark`: update, 4 argument(s)
- `generate`: update, 1 argument(s)
- `llmTarget`: query, 0 argument(s)
- `modelInfo`: query, 0 argument(s)
- `pruneQuotas`: update, 0 argument(s)
- `quotaOf`: query, 1 argument(s)
- `revoke`: update, 1 argument(s)
- `setLlmCanister`: update, 1 argument(s)
- `setOpenAccess`: update, 1 argument(s)
- `setQuota`: update, 1 argument(s)
- `setVerification`: update, 1 argument(s)
- `setWorkers`: update, 1 argument(s)
- `stats`: query, 0 argument(s)
