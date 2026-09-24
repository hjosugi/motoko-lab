# C2PA bridge

Issue #10. A registry record proves that a principal committed to an artifact's
hash at a point in time. That is only useful to someone who has the record's
URL. Media travels without URLs: through editors, CMSs and social networks, and
the provenance standard those tools read is C2PA. This bridge puts a record
reference inside a C2PA content credential, and makes a verifier check both the
credential and the record before it says anything.

Specification checked: **C2PA Technical Specification 2.4 (April 2026)**, on
2026-09-24, at spec.c2pa.org. Reference implementation used to confirm every
byte-level rule below: **c2patool 0.27.22** (c2pa-rs 0.90.22,
contentauth/c2pa-rs, released 2026-09-10).

## What a credential says, and what a record says

They are different claims, checked against different keys, and neither is the
source of truth for the other.

| | C2PA credential | Registry record |
| --- | --- | --- |
| Claim | "this signer vouches for these bytes and these assertions" | "this principal committed to this artifact hash, this manifest, at this time" |
| Signed by | the signer's X.509 key (COSE_Sign1) | nobody; the *subnet* certifies the canister's state |
| Trust root | a C2PA trust list (X.509 CAs) | the IC root key / subnet key |
| Withdrawn by | certificate revocation (OCSP) — not implemented here | `revokeRecord`, which is certified |
| Survives re-encoding | no; the hard binding breaks | no; the artifact hash breaks |
| Survives stripping | no | yes — the record does not live in the file |

So the verifier reports the two separately, and reports the bindings between
them separately again. A valid credential naming a revoked record is `revoked`,
not `verified` and not `invalid`: the credential is intact and says so, and the
record it relies on was withdrawn.

## The mapping

### Custom assertion `io.github.hjosugi.icp-proof`

C2PA requires entity-specific labels to begin with a reverse domain name the
entity controls, "similar to how Java packages are defined". This project
controls `hjosugi.github.io` (its documentation site), so the label is
`io.github.hjosugi.icp-proof`. `org.motoko-lab.*` would have been shorter, and
would squat a domain nobody here owns. A breaking change to the content would
be `io.github.hjosugi.icp-proof.v2`, following the `c2pa.actions.v2` convention.

CBOR map, in this order:

| Field | Type | From the record |
| --- | --- | --- |
| `version` | uint, `1` | — |
| `network` | tstr | where the canister lives: `icp`, `local`, `example` |
| `canisterId` | tstr | the registry canister, principal text |
| `recordId` | uint | `ProofRecord.id` |
| `owner` | tstr | `ProofRecord.owner`, the principal that signed the registration |
| `artifactHash` | bstr(32) | `ProofRecord.artifactHash` |
| `manifestHash` | bstr(32) | `ProofRecord.manifestHash` |
| `ai` | map `{assisted, mode}` | a summary of `ProofRecord.ai`; the record is authoritative |
| `query` | tstr | `getRecordCertified`, the method that returns certified evidence |

The hashes are repeated rather than only referenced because the verifier checks
the credential against the record *without trusting whoever served either*: a
record fetched for this credential must carry exactly these values.

It is a **created** assertion (C2PA 2.x claim v2 `created_assertions`), because
only created assertions are attributed to the signer. The verifier reads the
link only from a created assertion whose hashed URI verified. An ICP assertion
in `gathered_assertions` does not link anything, and the test suite has a case
for exactly that.

### `c2pa.hash.data` is the registered artifact hash

The hard binding hashes the file with the manifest store excluded. The bridge
inserts the store as one `caBX` chunk directly after `IHDR` and changes nothing
else, so **the bytes the binding covers are exactly the original file** — the
file whose SHA-256 the record registered. `c2pa.hash.data.hash`,
`icp-proof.artifactHash` and `ProofRecord.artifactHash` are the same 32 bytes,
and the verifier recomputes that value from the file rather than trusting any
of the three.

That is what makes the link work in both directions.

- **credential → record**: `canisterId` + `recordId` in the signed assertion.
- **record → asset**: the record never has to be updated to learn about the
  credential. Any copy of the asset, credentialed or stripped, hashes (with the
  store removed) to the registered `artifactHash`, which `getByArtifactHash`
  resolves. The replica test strips the credential and resolves the record
  from the remaining bytes.
- **record → credential signer**: the provenance manifest, whose digest the
  record commits to, may declare in advance which C2PA keys will issue
  credentials for it:

  ```json
  "extensions": {
    "io.github.hjosugi.c2pa": {
      "signers": [{ "spki": { "algorithm": "sha256", "hex": "<SHA-256 of the DER SubjectPublicKeyInfo>" } }]
    }
  }
  ```

  A key, not a certificate, so a renewed certificate for the same key keeps
  working. This closes **credential laundering**: anyone holding a copy of the
  asset can sign their own credential naming the creator's record, and every
  hash in it will match, because it *is* the same asset. Only the declaration
  in the committed manifest distinguishes the creator's signer from theirs, and
  a credential from an undeclared key is `invalid`.

### `c2pa.actions.v2`

A standard manifest must contain a `c2pa.created` or `c2pa.opened` action. The
bridge writes `c2pa.created` with an IPTC `digitalSourceType` derived from the
record's AI disclosure, and **refuses to understate it**:

| `ProofRecord.ai.mode` | default `digitalSourceType` |
| --- | --- |
| `generate` | `trainedAlgorithmicMedia` |
| `transform`, `assist` | `compositeWithTrainedAlgorithmicMedia` |
| `none`, `other` | none; the caller must choose (`digitalCapture`, `digitalArt`, …) |

`none` has no default because the registry does not know whether a human-made
artifact is a photograph or a drawing, and guessing would put a false statement
under the creator's signature. For an AI-assisted record, a non-AI source type
is refused when issuing and reported as `understated` (verdict `invalid`) when
verifying a credential someone else built.

## Verification

`protocol/tools/c2pa-bridge.mjs verify` runs, in order:

1. **Credential.** Parse the `caBX` chunk as a JUMBF manifest store; take the
   active (last) manifest; verify the COSE_Sign1 claim signature over the
   claim bytes with the leaf of `x5chain` (protected header); verify every
   hashed URI in the claim against the assertion bytes; recompute the data
   hash with the exclusions and require them to cover **exactly** the manifest
   store — an exclusion over `IDAT` would let every pixel change under a valid
   signature. Check the signing certificate's profile (claim-signing EKU, not a
   CA, not self-signed, inside its validity) and, if a trust list is given,
   that the chain ends at an anchor.
2. **Link.** Read `io.github.hjosugi.icp-proof` from a verified created
   assertion; its `artifactHash` must be this asset's unsigned hash; the
   actions' source type must not understate its `ai` summary.
3. **Registry.** Resolve the record — online through `getRecordCertified`, or
   offline from a saved bundle — and check the certificate: BLS over the state
   tree, `certified_data`, the witness root, and the record's digest recomputed
   locally with `apps/01_creator_proof_registry/test/record-digest.mjs`. Then
   the record must carry the credential's artifact hash, manifest hash and
   owner.
4. **Signer binding.** With the creator's manifest: its canonical digest must
   be the record's `manifestHash`, and the credential's signer key must be one
   it declares.
5. **Status.** A revoked record makes the verdict `revoked`.

| Verdict | Meaning | Exit |
| --- | --- | --- |
| `verified` | every check passed | 0 |
| `verified-with-warnings` | nothing failed; something could not be established: trust, certification, signer binding, freshness | 0 |
| `revoked` | the credential is intact and the record it names was withdrawn | 3 |
| `invalid` | the credential is broken (signature, hashed URI, hard binding, malformed file), or contradicts the record it names (different artifact, manifest or owner; understated AI use; undeclared signer) | 2 |
| `unlinked` | no signed ICP assertion, or a **broken link**: the record does not exist | 4 |
| `unverifiable` | the registry could not be consulted, or its answer failed certification | 5 |
| `no-credential` | the asset carries no C2PA manifest | 6 |

Usage errors exit 1. The report is JSON (`--json`) conforming to
`schemas/c2pa-verification-report.schema.json`, and always carries the warning
that registration evidence is not legal authorship proof.

A broken link and an unreachable registry are deliberately different verdicts.
"Record 999 does not exist on this canister" is a fact about the credential;
"the canister did not answer" is a fact about the network, and reporting it as
a broken link would let a network outage slander a valid credential.

### Offline verification

A bundle (`format: icp-certified-record/1`) is what `getRecordCertified`
returned — the record as JSON, the certificate, the witness — plus the root key
it verifies against and when it was fetched. With the agent library installed
(`node tools/pocket-ic/setup.mjs`), the CLI verifies the certificate offline;
without it, the bundle is read and the report says `certification: unverified`.

An offline verdict is only as fresh as its bundle. A record revoked after the
bundle was saved still reads active, and the report says as of when. The
replica test asserts both halves: the old bundle still says active (with the
date), a new bundle carries the certified revocation, and splicing the old
active record onto the new certificate fails certification.

## Trust and revocation semantics

- **Two trust roots, never merged.** The credential's signer is trusted through
  X.509 (the C2PA trust list in production, `test-root-ca.pem` in the example);
  the record through the IC root key. Neither vouches for the other. The
  signer declaration is what connects a *particular* signer to a *particular*
  creator, and it lives in the manifest the creator committed to before the
  credential existed.
- **Record revocation is authoritative for provenance.** It is certified, so an
  intermediary cannot hide it from an online verifier. It does not touch the
  credential, which is why the report still shows the credential as valid.
- **Credential revocation is certificate revocation.** A compromised signing
  key is revoked by its CA (OCSP / CRL). Not implemented here; the verifier's
  signer check is chain + profile + validity only, and `c2patool` performs
  OCSP when it is configured to.
- **A key the creator stops using** is removed from future manifests. Records
  already committed keep declaring it, which is correct: at the time of those
  records it was the creator's key. This mirrors how #7 keeps a rotated-away
  principal in the key history rather than rewriting old records.
- **Stripping is not revocation.** A stripped copy has no credential
  (`no-credential`) and still resolves to its record by hash.

## Conformance

The writer and validator implement a subset, stated exactly:

| | Implemented | Not implemented |
| --- | --- | --- |
| Container | PNG, `caBX` after `IHDR` | JPEG (APP11), BMFF, PDF, remote and sidecar manifests |
| Manifest | one standard manifest, claim v2, CBOR assertions, per-assertion salt | ingredients, update manifests, redaction, JSON-LD assertions, thumbnails |
| Hard binding | `c2pa.hash.data`, SHA-256, one exclusion | `c2pa.hash.boxes`, `c2pa.hash.bmff`, SHA-384/512 |
| Signature | COSE_Sign1 detached; Ed25519, ES256/384/512, PS256/384/512 verification; Ed25519 and ES256 signing | RFC 3161 timestamps, OCSP stapling |
| Validation | claim signature, hashed URIs, data hash with exact-exclusion check, signer profile, chain to anchor | full trust-list policy, basic keyUsage bits (Node does not expose them; c2patool checks them) |
| Reading others | indefinite-length CBOR, floats, absolute and relative JUMBF URIs, claim v1 `assertions` | following URIs into other manifests |

`protocol/tools/c2pa-crosscheck.mjs` checks both directions against c2patool
0.27.22. Result on 2026-09-24:

- the published example credential: `validation_state: Trusted` with the test
  root as trust anchor and no failure codes; without it, `Valid` with exactly
  one failure, `signingCredential.untrusted`;
- a fresh ES256 credential written here: `Trusted`;
- a credential c2patool writes with its own sample ES256 chain (including
  thumbnails, an ingredient and gathered assertions): claim signature, every
  hashed URI and the data hash verify here.

Two byte-level rules were settled by measuring c2patool's output rather than by
reading: an assertion's hashed URI covers the superbox **payload** (description
box and content boxes, not the superbox's own `LBox`/`TBox`), and the
`c2pa.hash.data` exclusion covers the whole `caBX` chunk, length and CRC
included.

## Files

| Path | What |
| --- | --- |
| `tools/cbor.mjs` | deterministic CBOR encoder, strict decoder |
| `tools/jumbf.mjs` | JUMBF boxes and C2PA box UUIDs |
| `tools/x509.mjs` | test PKI issuance (Ed25519, DER written by hand) and chain evaluation |
| `tools/cose.mjs` | COSE_Sign1 with detached payload |
| `tools/c2pa.mjs` | PNG manifest writer and validator |
| `tools/c2pa-bridge.mjs` | the ICP assertion, issuing, bundles, verification, CLI |
| `tools/c2pa.test.mjs` | offline suite, in `scripts/run_offline_checks.sh` |
| `tools/c2pa-crosscheck.mjs` | c2patool cross-check, outside CI |
| `../tools/pocket-ic/c2pa-bridge.test.mjs` | end to end against app 01 on pocket-ic, in the Replica workflow |
| `schemas/c2pa-verification-report.schema.json` | the report |
| `examples/c2pa/` | a credentialed PNG, its record bundle, the creator's manifest, the test root |

The example is deterministic — fixed image, fixed test keys derived from public
strings, fixed ids and salts — and the offline suite asserts the committed
files are byte-identical to what the code produces. Its keys are test keys and
its record is not on any network: its owner is the anonymous principal, which
the registry refuses to register, so it cannot be mistaken for a real proof.

```bash
node protocol/tools/c2pa-bridge.mjs verify protocol/examples/c2pa/gradient.c2pa.png \
  --bundle protocol/examples/c2pa/record-bundle.json \
  --trust-anchors protocol/examples/c2pa/test-root-ca.pem \
  --manifest protocol/examples/c2pa/manifest.json
node protocol/tools/c2pa-bridge.mjs inspect protocol/examples/c2pa/gradient.c2pa.png
node protocol/tools/c2pa-bridge.mjs example   # regenerate examples/c2pa/
```
