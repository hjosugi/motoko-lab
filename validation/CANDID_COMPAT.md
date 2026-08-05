# Candid Compatibility

Baseline: `v2026.08.05`
Status: **pass**

| canister | check | status | detail |
|---|---|---|---|
| `01_creator_proof_registry/backend` | drift | pass |  |
| `01_creator_proof_registry/backend` | compat | pass |  |
| `02_merkle_anchor/backend` | drift | pass |  |
| `02_merkle_anchor/backend` | compat | pass |  |
| `03_license_marketplace/backend` | drift | pass |  |
| `03_license_marketplace/backend` | compat | pass |  |
| `04_bounty_board/backend` | drift | pass |  |
| `04_bounty_board/backend` | compat | pass |  |
| `05_usage_metered_saas/backend` | drift | pass |  |
| `05_usage_metered_saas/backend` | compat | pass |  |
| `06_distributed_llm/backend` | drift | pass |  |
| `06_distributed_llm/backend` | compat | pass |  |
| `06_distributed_llm/llm_shim` | drift | pass |  |
| `06_distributed_llm/llm_shim` | compat | pass |  |
| `06_distributed_llm/worker_0` | drift | pass |  |
| `06_distributed_llm/worker_0` | compat | pass |  |
| `fixture/additive-method.did` | self-test | pass | a new method is invisible to clients written against the release |
| `fixture/optional-argument-field.did` | self-test | pass | an optional argument field is the backwards-compatible way to extend an input: a caller that omits it sends null, which is a valid value |
| `fixture/added-result-field.did` | self-test | pass | a record with more fields is a subtype, and results are covariant, so an old client simply ignores the new field |
| `fixture/removed-method.did` | self-test | pass | a client that calls the removed method gets no such method after the upgrade |
| `fixture/renamed-method.did` | self-test | pass | a rename is a removal and an addition; Candid sees only the removal |
| `fixture/required-argument-field.did` | self-test | pass | an existing caller cannot supply a field it has never heard of, so the new required field rejects every old call |
| `fixture/narrowed-argument.did` | self-test | pass | nat32 is not a supertype of nat; arguments are contravariant, so narrowing one rejects values the release accepted |
| `fixture/removed-variant-tag.did` | self-test | pass | the tag is removed from a variant used as an argument, so a caller that still sends it is rejected |
| `fixture/added-variant-tag.did` | self-test | pass | didc exits 0 here: Candid's special opt rule lets an old client decode the unknown tag as null rather than trap, so the call succeeds and the client silently sees nothing. The exit code says compatible and the deployment says data loss, which is why the checker treats the FIX ME banner as a break |
