# AI tool and model attestation

Issue #39. A provenance manifest's `ai` block is the creator's own account of
how AI was used. It is useful, and it is weak: whoever wrote the manifest
chose what it says. An **attestation** is the same kind of statement made by
someone else and signed: the tool that produced the output, or an
organization that reviewed the evidence. A verifier can then weigh it by who
made it.

Attestations are Verifiable Credentials ([VERIFIABLE_CREDENTIALS.md](VERIFIABLE_CREDENTIALS.md)).
Issuance, `eddsa-jcs-2022` proofs, the issuer policy, key rotation,
compromised keys and status-list revocation are therefore the ones #11 already
specifies and tests. This document covers what is specific to AI evidence.

## Evidence levels

| Level | Meaning | Made by |
| --- | --- | --- |
| `none` | the manifest discloses nothing about AI | — |
| `self-asserted` | the manifest's `ai` block, and nothing else | the creator |
| `tool-signed` | an `AIGenerationAttestation` from a **provider** service or a registered **local tool**, verified and bound to the artifact | the tool |
| `organization-reviewed` | an `AIUsageReviewCredential` with outcome `consistent`, from an **organization** in the policy | a reviewer |

The level is reported with the evidence behind it, never alone. The report
(`evaluateAiEvidence`, format `ai-evidence/1`) lists every attestation and
review, each with its verdict, the kind of issuer, and its binding
(`artifact`, `parent`, `replayed`, `malformed`), plus errors and warnings.

What each kind of issuer can raise the level to is fixed by the `kind` of its
policy entry: `provider`, `local-tool` or `organization`. A provider cannot
review its own attestation up to `organization-reviewed`, and a reviewer
cannot attest to generation. An attestation from an issuer the policy does not
know adds nothing, and the report says so. This follows #11's
`unknown-issuer` rule: a valid signature from nobody in particular is not
evidence of anything but self-assertion.

## `AIGenerationAttestation`

Schema: `schemas/ai-attestation.schema.json`. Builder: `generationAttestation`.

```json
"credentialSubject": {
  "id": "urn:sha256:<output.sha256>",
  "output": { "sha256": "<64 hex>", "mediaType": "text/plain" },
  "generation": {
    "provider": "Example AI Provider",
    "model": { "id": "example-text-model", "version": "2026-07-01", "alias": "example-text-model-latest" },
    "role": "generate | transform | assist",
    "prompt": { "scheme": "icp-ai-prompt:v1", "digest": "<64 hex>" },
    "generatedAt": "2026-07-20T00:04:00Z"
  },
  "requestedBy": "urn:icp:principal:<text>"
}
```

- **`output.sha256`** is what the tool produced, and the subject id repeats
  it. This binding is what makes replay impossible. See below.
- **`model.version`** is required. An alias such as `…-latest` names a moving
  target. The same alias meant a different model last month, and evidence
  that could refer to either is evidence of neither. The alias is kept for the
  record, and the report shows what it resolved to.
- **`model.weightsSha256`** identifies a local model by the weights file that
  ran, since a local model has no provider-assigned version to trust.
- **`prompt`** is a sealed commitment. It is never the prompt, and never an
  unsalted hash of it.
- **`requestedBy`** is optional: the principal the tool served. A mismatch
  with the manifest's creator is flagged, not rejected. A studio's tool may
  legitimately serve an employee on behalf of the studio's identity.

## Sealed prompts

```text
SHA-256( UTF8("icp-ai-prompt:v1") || 0x00 || salt (16..64 bytes) || 0x00 || UTF8(prompt) )
```

A plain SHA-256 of a prompt is not private. Prompts are short and predictable,
and anyone can hash guesses until one matches. The suite shows exactly this:
a list of three guesses recovers the example prompt from its plain hash, and
finds nothing against the sealed commitment. The creator keeps the salt. To
show the prompt to an auditor, they disclose salt and prompt, and `openPrompt`
checks them against the commitment. **Nobody needs the prompt publicly**, and
the attestation, the manifest and the registry never carry it.

The manifest's `ai.promptDigest` holds the same sealed value. Its schema type
is a SHA-256 digest, which this is. A tool attestation whose commitment
differs from the manifest's is an error: the two sides committed to different
prompts.

The layout follows `COMMITMENT_V1.md`: a versioned domain, separators, and a
fixed order.

## Binding, and why an attestation cannot be replayed

An attestation counts only if its `output.sha256` is:

- the registered artifact itself (binding `artifact`), or
- one of the manifest's declared `derivation.parents[].artifactDigest`
  (binding `parent`). This covers the common case where the tool produced a
  draft and the creator edited it, and the manifest is what the record
  commits to.

Anything else is a **replay**: an attestation for someone else's output, or
for this creator's other work, presented for this artifact. It is reported
under that name and counts for nothing. A replay presented alongside a
genuine attestation also caps the level at `self-asserted`, because presenting
one is itself a reason to doubt the rest.

Reviews bind the same way (`urn:sha256:<artifact>`), and they name the
attestation they read by the SHA-256 of its JCS form, proof included. A
reissued attestation keeps its id and changes its digest, so a review does not
carry over to it.

## Consistency with the manifest

The verifier compares the attestation with the manifest the record committed
to:

- a tool attesting AI use that the manifest does not disclose is an
  **understatement**. It is an error, and the level drops to `self-asserted`
  rather than rising. The creator's disclosure is what the record binds, and
  a tool cannot fix it after the fact;
- a model the manifest's `ai.systems` does not list is a warning;
- a prompt commitment that differs from the manifest's is an error.

## Trust, rotation and revocation

These are handled by the issuer policy of #11, with a `kind` per entry:

```json
{ "name": "Example AI Provider", "kind": "provider", "types": ["AIGenerationAttestation"],
  "keys": [
    { "verificationMethod": "did:key:…#…", "activeFrom": "2025-01-01T00:00:00Z", "retiredAt": "2026-06-01T00:00:00Z", "status": "superseded" },
    { "verificationMethod": "did:key:…#…", "activeFrom": "2026-06-01T00:00:00Z", "retiredAt": null, "status": "active" }
  ] }
```

- **Rotation.** An attestation signed by a superseded key before its
  retirement stays valid, with a warning. One signed afterwards is rejected.
- **Compromise.** A key marked `compromised` invalidates everything it
  signed, including attestations dated earlier, because the signer writes
  `created` and a thief can backdate it.
- **Revocation.** Attestations may carry a Bitstring Status List entry. It is
  checked against a list signed by the same issuer, and a revoked attestation
  counts for nothing.

## Threat model

| Threat | Mitigation | Test |
| --- | --- | --- |
| Creator overstates or invents AI provenance | Self-assertion is labelled as such; `tool-signed` needs a key the policy trusts | `self-asserted` baseline, unknown local key |
| Creator understates AI use | A tool attestation contradicting the manifest is an error, not an upgrade | understated manifest |
| Attestation reused for another artifact | Output digest binding; replay reported and disqualifying | replay, replay beside a valid one, review of another artifact |
| Review reused for a changed attestation | Review names the attestation's digest | reissued attestation |
| Prompt leaked through its hash | Salted commitment; prompt never published | guessing the plain hash vs the sealed one |
| Provider key stolen | `compromised` status voids the key's past as well as its future | compromised key |
| Provider rotates keys | Key history with activation windows | before and after rotation |
| Provider unavailable at generation | No attestation: the level says `self-asserted` and warns | provider unavailable |
| Provider unavailable at verification | The attestation verifies offline; only its status list needs the provider, and that fails closed unless the policy chooses to warn | status list unreachable |
| Model alias changes meaning | `version` required; alias kept and reported | alias, alias-only |
| Local model run on the creator's own key | A local tool counts only if the policy registers its key, and even then the report says it proves the tool ran, not who ran it | local model, unregistered local key |
| Prompt injection into metadata (newlines, ANSI escapes, bidi overrides in model names) | Control and bidi-override characters are refused even in a correctly signed attestation. The signature makes the issuer accountable, not the text safe | three injected model ids, an injected provider name |

What this does not establish: that a human did or did not do anything the
attestation is silent about; that a provider's statement about its own model
is true; or authorship in any legal sense. Registration evidence is not legal
authorship proof, and neither is this.

## Files

| Path | What |
| --- | --- |
| `tools/ai-attestation.mjs` | builders, sealed prompts, `evaluateAiEvidence`, CLI (`example`, `evaluate`) |
| `tools/ai-attestation.test.mjs` | offline suite, in `scripts/run_offline_checks.sh` |
| `schemas/ai-attestation.schema.json` | the attestation credential |
| `examples/ai-attestation/` | a manifest, a provider attestation, a studio review, the policy, and the sealed-prompt disclosure an auditor would receive |

```bash
node protocol/tools/ai-attestation.mjs evaluate \
  3eabac0a5996ee655269410d496b8c48eb23dd051094bd53aa30c5437a859eb3 \
  protocol/examples/ai-attestation/manifest.json protocol/examples/ai-attestation/policy.json \
  protocol/examples/ai-attestation/provider-attestation.json \
  --review protocol/examples/ai-attestation/studio-review.json
```
