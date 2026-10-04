# Privacy and data protection

On-chain data is replicated, public and effectively permanent. That is the
property the registry sells, and it is also the property that makes personal
data dangerous to put there: a deletion request cannot be satisfied by deleting
a record, a hash of a guessable value is not confidentiality, and a pointer to
private evidence is itself the disclosure. This document is the review issue
#20 asks for: what is on chain, what it is classified as, what stays off
chain, and what the operator must do when the law and the ledger disagree.

It is a technical and operational review, not legal advice. `docs/35`-tracked
work (issue #35) is where the terms and the claims get their own sign-off.

## The classification is machine-checked

`privacy/fields.json` classifies every field of every committed `.did`, and
`scripts/check_privacy.py` enforces it:

```sh
python3 scripts/check_privacy.py . --self-test
```

- every record field and every inline record payload must have an entry; a
  field added to a schema and left unclassified fails CI;
- the class `raw-personal` is forbidden — the schemas must not require a raw
  prompt, email, IP address or private source on chain;
- a `hashed` field must say whether its preimage is high-entropy,
  user-controlled or low-entropy, and a low-entropy preimage needs a
  documented mitigation;
- a `user-content` field must name the publication warnings that apply to it;
- a `sealed` field must name the custodian process that keeps the pointer off
  chain.

The self-test mutates the inventory six ways (an unclassified field, a
forbidden class, a low-entropy hash without a mitigation, user content without
a warning, an unknown warning id, a sealed field without a process) and
requires each to be caught. Today: 333 fields, 22 hashed, 31 user content, 1
sealed, 277 public and 2 metadata.

## What the classes mean

| Class | Meaning | On-chain rule |
|---|---|---|
| `public` | Identifiers, principals, amounts, statuses, counts, timestamps, model outputs | Safe to publish; principals are pseudonymous, not legal identities |
| `metadata` | Protocol or format values (memos, salts, encodings, limits) | Not evidence and not personal |
| `hashed` | A digest or root, with its preimage's entropy stated | A low-entropy preimage needs a mitigation; a hash is never treated as confidentiality |
| `user-content` | Free text or a pointer a caller chooses | Must carry publication warnings; no personal data |
| `sealed` | A reference to evidence the registry never holds | Only a digest and a custodian label; the pointer stays off chain |

### The hashed fields that matter

| Field | Preimage | Why |
|---|---|---|
| `commitmentHash` | principal + manifest hash + 16–64 byte salt | High-entropy salt; the salt is revealed with the record so the commitment can be re-verified |
| `artifactHash`, `manifestHash` | the artifact or manifest | User-controlled: publishing the hash of a low-entropy artifact is a confirmation oracle, so private artifacts stay off chain |
| `promptHash` | a prompt | **Low-entropy**: prompts are guessable. Publish only for public or high-entropy prompts; otherwise seal the prompt and treat the hash as a commitment |
| `digest` (evidence) | a piece of evidence | **Low-entropy**: a short note or a known document is guessable. Private evidence stays encrypted off chain; the digest alone is not confidentiality |
| `hash` (API keys, batches, dispute events), roots, proofs, chain links | protocol data | Fixed-width or high-entropy; no dictionary risk |
| `receiptHash`, `termsHash`, `criteriaHash`, `descriptionHash` | caller-supplied documents | User-controlled; the document is the caller's to publish |

### User content and pointers

31 fields are free text or pointers: `title`, `statement`, `summary`, `note`,
`description`, `reason`, `displayName`, `keyLabel`, `idempotencyKey`,
`storageUri`, `termsUri`, `evidenceUri`, and the LLM protocol fields
(`prompt`, `content`, `message`, `text`, `value`, `arguments`). None is
required to carry personal data, and several must not: `displayName` and
`keyLabel` are operator-chosen labels, `idempotencyKey` is an identifier, and
the LLM fields are transient call arguments that the reference backend does not
persist.

The warnings a UI must show before an irreversible write are in
`privacy/warnings.json`:

- **irreversible-publication** — "This will be written to an immutable public
  canister. It cannot be edited or deleted, only superseded by a new record or
  withdrawn by revocation."
- **no-personal-data** — "Do not enter names, email addresses, IP addresses,
  or private source. On-chain free text is permanent and public."
- **private-evidence-off-chain** — "Keep private evidence in your own storage;
  only a digest and a custodian label go on-chain."

The production frontend (#26) is the place these become pixels; this issue
fixes the copy and the field-to-warning mapping so the UI cannot invent
weaker wording.

## What the acceptance criteria mean here

- **No raw prompt, email, IP or private source is required on chain.** No
  schema has an email or IP field, the checker forbids a `raw-personal` class,
  and the one raw-prompt path (app 06's `generate`) is a transient call
  argument. Private source can appear only as a digest and a sealed custodian
  label.
- **The UI warns before irreversible publication.** The warning inventory
  above, enforced for every user-content field.
- **Export and dispute workflows respect access policy.** Sealed evidence has
  no URI on chain (asserted by app 01's replica suite), the dispute export
  carries only digest, custodian and description, and the portable export
  policy (#19) replaces storage URIs before the digests are computed, so a
  redacted export cannot be mistaken for a full one.
- **Terms accurately describe the limitations.** `docs/19_LIMITATIONS_AND_LEGAL.md`
  states that registration is not authorship, that a hash of low-entropy
  content is not confidentiality, and that deletion cannot be promised for
  on-chain data.

## Retention and deletion

| Data | Where | Retention | Deletion |
|---|---|---|---|
| Commitments, records, revocations, disputes | On chain | Permanent; ids are never reused | None. A record can be revoked or superseded; the history stays |
| Private evidence and original artifacts | Caller's own storage (vault, IPFS with encryption, etc.) | The caller's policy | Deleted by the caller; the chain keeps only the digest and the custodian label |
| Free-text fields (title, statement, summary) | On chain | Permanent | None; that is what the warning is for |
| Usage events, invoices, API key hashes (app 05) | On chain | Per the operator's contract; no automatic expiry | The tenant is disabled, keys are revoked; the billing history stays |
| Payment blocks, receipts | On chain (references to the ledger) | Permanent | None; the ledger is the record |

The off-chain deletion process is therefore a **custody** process, not a chain
operation: the evidence owner deletes the object from their storage and (if
they want the registry to say so) revokes the record. The registry cannot
confirm that a deletion happened and must not claim to; a dispute can add a
counterclaim or evidence pointing at the deletion, and the original record
stays as it was. Operators must document their own vault retention, key
custody and backup deletion in their runbook (`docs/07_OPERATIONS_RUNBOOK.md`).

## Dictionary attacks on hashes

A hash discloses its input exactly when the input can be guessed. The review
above classifies each hashed field; the operational rules that follow are:

1. **Never treat an unsalted hash as confidentiality.** If the preimage is
   low-entropy (`promptHash`, evidence `digest`), either the preimage is
   already public, or it is sealed off chain and the hash is a commitment.
2. **Salt anything that must stay unguessable.** Commitments already bind a
   16–64 byte salt; private evidence should be encrypted with a random key and
   the digest taken over the ciphertext, not over the plaintext.
3. **Do not publish confirmation oracles.** An attacker who can test a guess
   by comparing it to an on-chain digest has an oracle; the mitigation is to
   keep the digest off chain or make the preimage high-entropy.
4. **Assume metadata leaks.** Timestamps, counts and statuses can narrow a
   guess even when the payload is hashed; the export and dispute formats keep
   digests and labels only, and nothing resolves a sealed custodian to a
   location.

## DPIA / legal review checklist

The review issue #20 tracks the technical side; the legal side is a checklist
for the operator's counsel, with the scenarios the issue names:

| Scenario | Question to answer before launch |
|---|---|
| **Low-entropy hash** | Can a user's evidence or prompt be guessed and confirmed against a published digest? If yes, has the UI forced sealing or high-entropy salting? |
| **Minor user** | What age gate and parental-consent process applies in each supported jurisdiction? Is a minor's free text on chain acceptable at all? |
| **Court order / takedown** | Who receives it, what can the operator actually do (revoke, counterclaim, add a statement), and what must the terms say about the impossibility of deletion? |
| **Cross-border storage** | On-chain data is replicated across node providers in multiple jurisdictions; off-chain vaults are wherever the operator put them. Which transfer mechanism covers each? |
| **Data-subject request** | What is the response template when the data is on chain, and when only a digest is? Which fields can be suppressed in a future export? |
| **AI provider terms** | Do the provider's terms allow the prompt hash or disclosure the product asks for? Is a DPA in place? |

The operator's own record must name a DPO or equivalent, a lawful basis per
processing purpose, a retention schedule for off-chain copies, and a breach
process. None of that is created by this repository; this document is the
technical input to it.

## What remains

- The production frontend (#26) must render the warnings and must not offer a
  path that skips them.
- The terms and claims review (#35) signs off the public wording, the
  jurisdiction list and the escalation process.
- The operator's DPIA, DPO appointment and transfer mechanism are outside the
  repository.
- The export format's policy filter (#19) covers storage URIs; extending it to
  free-text fields is a product decision with a real cost (a redacted record
  can no longer be verified against the source digest), and is left for #38.
