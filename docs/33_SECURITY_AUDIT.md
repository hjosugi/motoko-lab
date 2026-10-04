# Security audit

The reference implementation must not handle funds or high-value evidence
without independent review (issue #21). This document is the audit brief: what
gets frozen, what an auditor is asked to look at, how findings are tracked and
remediated, and what has to be true before a production launch. It is the
repository's half of the engagement; the engagement itself — selecting an
auditor, the contract, the report — is a human step and is **not yet done**.

## Status

| Item | State |
|---|---|
| Audit scope, severity model, remediation process | written here |
| Threat model to freeze | `docs/05_SECURITY_THREAT_MODEL.md` plus each app's `docs/THREAT_MODEL.md` |
| Freeze tooling | `scripts/freeze_audit_scope.sh` writes `security/audit/FROZEN.json` (commit, tree, module and Candid hashes) |
| Findings register and gate | `security/audit/findings.json`, enforced by `scripts/check_audit_findings.py` |
| Auditor commissioned | **no** — this issue stays open until an engagement exists and its findings are remediated |
| Report published or customer-accessible | pending the engagement |

The freeze must be taken from a clean tree and committed, so the auditor's
report can name one commit and the remediation can name another. Run:

```sh
scripts/freeze_audit_scope.sh
git add security/audit/FROZEN.json && git commit -m "chore: freeze the audit scope"
```

## What is in scope

- **Motoko source** of all six applications, the shared protocol encodings
  (commitment, record digest, dispute log, export format) and the lab
  migration chain.
- **Generated Candid** and the committed `.did`: drift from the source and
  compatibility with the last release are already checked in CI, so the
  auditor is asked whether the checks are the right ones, not to redo them.
- **Stable data and upgrades**: what survives an upgrade, what a migration
  can corrupt, what the enhanced-migration chain does at scale.
- **Cryptography and canonicalization**: SHA-256 preimages and domain
  separation, the RFC 8785 implementation, Merkle tree rules, the Ed25519 and
  P-256 verification paths, and the JS readers that mirror each Motoko
  encoding (a divergence between the two sides of a trust boundary is the
  class of bug this kit is built around).
- **Payments and escrow**: the ICRC-1/2/3 adapters, the manual receipt path,
  the invoice and adjustment model, and every place a block index is trusted.
- **Authorization and governance**: the privileged-action inventory
  (`docs/26_GOVERNANCE_DECISION_RECORD.md`), controller powers, the restore
  path's empty-canister gate, and rate limits.
- **Certified queries and the client verifier**: the hash tree, the
  certificate check, and the C2PA/VC bridges.
- **Disaster recovery**: the portable export/restore format and the drill
  runbook (`docs/31_PORTABLE_EXPORT.md`, `docs/07_OPERATIONS_RUNBOOK.md`).
- **Supply chain**: pinned toolchain and dependencies, reproducible Wasm.

## What is out of scope

- The production frontend (it does not exist yet, #26) and the operator's
  off-chain vault, billing provider and legal terms.
- The correctness of the ICP platform itself and of the ledgers the
  applications talk to.
- Third-party canister services the apps call by principal (the LLM canister,
  exchange-rate feeds); the auditor is asked to review how they are trusted,
  not their internals.

## What the auditor receives

- The repository at the frozen commit, with `security/audit/FROZEN.json`
  naming the module and Candid hashes.
- The threat models, the governance record, the privacy classification
  (`docs/32_PRIVACY_AND_DATA_PROTECTION.md`) and the issue backlog.
- The test harnesses: `mops test`, `tools/pocket-ic/run.mjs`,
  `tools/state-machine/run.mjs`, `scripts/check_all_apps.sh`,
  `scripts/check_reproducible_build.sh`, and the offline checks. The auditor
  is encouraged to add adversarial cases to the state-machine models rather
  than only reading them.
- A statement of what is known to be unfinished (`VALIDATION_STATUS.md`), so
  effort goes to the unknown.

## Severity and response

| Severity | Meaning | Required before launch |
|---|---|---|
| Critical | Loss of funds, forgery of a record or certificate, unauthorized control | Remediated and re-tested, or the launch does not happen |
| High | Authorization bypass, permanent data corruption, export/restore integrity failure | Remediated and re-tested, or accepted by the owner with an expiry |
| Medium | Denial of service, bounded data exposure, upgrade fragility | Remediated, accepted with owner and expiry, or scheduled |
| Low | Hardening, diagnostics, documentation | Scheduled |
| Informational | Observations, no action required | None |

Accepted risk means the owner of the affected component has decided to live
with it until an expiry date, with a written rationale. The register enforces
both, and an expired acceptance fails CI so it cannot become permanent by
neglect. A critical or high finding cannot be accepted *open* at launch:
`scripts/check_audit_findings.py` fails while one is.

## Findings register

`security/audit/findings.json` is the single list, whether a finding comes
from the independent auditor, an internal review or a user report. Each entry
has an id, title, severity, status, component, evidence, and the fields its
status requires:

```json
{
  "id": "A-001",
  "title": "short description",
  "severity": "high",
  "status": "remediated",
  "component": "apps/01_creator_proof_registry/backend/src/main.mo",
  "evidence": "report section, issue link or reproduction",
  "remediation": "commit or PR that fixed it",
  "retest": "how the fix was re-verified"
}
```

Statuses: `open`, `remediated`, `accepted`, `false-positive`. The gate:

```sh
python3 scripts/check_audit_findings.py . --self-test
```

## Remediation and publication

1. **Triage** within five working days of the report: severity agreed, owner
   named, register updated.
2. **Remediate** on a branch whose commit names the finding id; the fix adds a
   regression test, and for the state-machine models a failing sequence that
   the shrinker reduced.
3. **Re-test** independently of the fix's author; the register records how.
4. **Publish** what is safe: the finding ids, severities, affected versions
   and fix commits, and the report itself when the auditor allows it. A
   customer who cannot see the scope and the commit hashes cannot check the
   claim that the audit happened.
5. **Freeze again** after remediation if the change is material, so the
   re-test and the original report name the same moving target.

## Acceptance gates

- [ ] No unresolved critical or high finding at production launch —
  enforced by the register check.
- [ ] Every accepted risk has an owner and an expiry — enforced by the
  register check.
- [ ] Audit scope and commit hashes are public or customer-accessible —
  `docs/33` and `security/audit/FROZEN.json` are in the repository, and the
  report is published under step 4.

Until the engagement exists, the first two boxes are satisfied vacuously (an
empty register) and the third only in part. That is the honest state of the
repository, not a completed audit.
