# Verifiable Credentials

Issue #11. A principal proves that someone holds a key. It does not show that
the key belongs to a member of an organization, that its holder may publish
for a creator, or that a reviewer examined a record. Those are claims made by
someone else, and a W3C Verifiable Credential is the standard way to carry
"this other party says so, and here is their signature".

Specifications checked on 2026-09-24:

- **Verifiable Credentials Data Model v2.0**, W3C Recommendation (15 May 2025)
- **Data Integrity EdDSA Cryptosuites v1.0**, W3C Recommendation, 15 May 2025:
  `eddsa-jcs-2022`
- **Bitstring Status List v1.0**, W3C Recommendation, 15 May 2025

## Why `eddsa-jcs-2022`

A Data Integrity proof signs a canonical form of the credential. The two
choices are RDF canonicalization (`eddsa-rdfc-2022`, which needs a JSON-LD
processor and network access to fetch contexts, or a pinned context cache) and
JCS (`eddsa-jcs-2022`, RFC 8785). This repository already implements RFC 8785
to the byte, with official vectors and two independent cross-checks
([CANONICALIZATION.md](CANONICALIZATION.md)), and uses it for the manifest
digest that the on-chain commitment binds. Using it again means one canonical
form in the whole protocol, and verification needs no network.

The algorithm, as implemented in `tools/vc.mjs`:

1. Proof options: `type: DataIntegrityProof`, `cryptosuite: eddsa-jcs-2022`,
   `created`, `verificationMethod`, `proofPurpose`, plus the document's
   `@context` when it has one.
2. `hashData = SHA-256(JCS(proof options)) || SHA-256(JCS(document without proof))`.
   The proof configuration hash comes first.
3. Ed25519 over `hashData`; `proofValue` is the signature, multibase
   base58-btc (`z…`).
4. Verification removes `proof`, removes `proofValue` from it, checks that
   the proof's `@context` is a prefix of the document's, and recomputes.

The W3C Recommendation's own vector (Appendix B.3) is vendored in
`test-vectors/vc/eddsa-jcs-2022.json`. The suite reproduces every intermediate
value exactly: both canonical forms, both hashes, the combined hash, and the
64-byte signature. That is the one check here that does not compare this
implementation with itself. Ed25519 is deterministic, so a matching signature
means the whole pipeline matches.

Keys are **Multikey**: `z` plus base58-btc of `0xed 0x01` and the 32-byte
public key (`0x80 0x26` and the seed for a secret key). Issuers are `did:key`
DIDs, which resolve with no network. The verifier accepts only the canonical
verification method `did:key:<k>#<k>`, because a URL whose fragment named
another key would let one DID appear to authorize another's signature.

## Credential types

All three use the VC 2.0 context alone. Their type names are
**issuer-dependent terms**: VC 2.0's `@vocab` maps them to
`https://www.w3.org/ns/credentials/issuer-dependent#…`. This is deliberate.
A JCS proof does not expand JSON-LD, so a custom context would add a URL that
has to be hosted and kept stable while adding nothing to verification. When
these types need globally resolvable semantics, a context goes in front of the
VC 2.0 context and the proof covers it.

Subjects are principals, named as `urn:icp:principal:<text>`. There is no
registered DID method for ICP principals, and inventing one would be worse
than using a URN that names exactly what it is. The principal must be in
canonical textual form (`tools/principal.mjs`), the same rule the commitment
uses.

| Type | Issuer | Subject | Claims |
| --- | --- | --- | --- |
| `CreatorMembershipCredential` | an organization | a creator's **current root** principal | `memberOf` (organization name), `role`, optionally `creator: {canisterId, creatorId}` |
| `DelegatedAuthorityCredential` | the creator | the delegate principal | `authorizedBy: {canisterId, creatorId, delegationId}`, `scope: all \| collection` |
| `ProvenanceReviewCredential` | a reviewer | `urn:icp:record:<canister>:<id>` | the reviewed `artifactHash` and `manifestHash`, `review: {outcome, method}` |

A review's `outcome` is `consistent`, `inconsistent` or `inconclusive`. It is
a statement about evidence, not about authorship or ownership, and
`inconclusive` exists so a reviewer is never forced to pick a side.

Builders: `membershipCredential`, `delegationCredential`, `reviewCredential`,
`signCredential`. Examples are in `examples/vc/`. They are deterministic, the
suite rebuilds them byte for byte, and their keys are test keys derived from
public strings.

## Issuer policy

A valid signature says that whoever holds the key signed the credential. It
says nothing about whether they had any authority to. The verifier's policy
supplies that:

```json
{
  "statusFailure": "reject",
  "issuers": [{
    "name": "Example Studio",
    "types": ["CreatorMembershipCredential"],
    "requireStatus": true,
    "keys": [
      { "verificationMethod": "did:key:z6Mk…#z6Mk…", "activeFrom": "2025-01-01T00:00:00Z", "retiredAt": "2026-03-01T00:00:00Z", "status": "superseded" },
      { "verificationMethod": "did:key:z6Mk…#z6Mk…", "activeFrom": "2026-03-01T00:00:00Z", "retiredAt": null, "status": "active" }
    ]
  }]
}
```

- **An unknown issuer is a warning, never a success.** The verdict is
  `unknown-issuer`, the proof is still reported as verified, the warning says
  why that is not enough, and the CLI exits 2. Status is still checked, so an
  unknown issuer's revoked credential is `rejected`.
- **Authority is per type.** A trusted reviewer issuing a membership credential
  is `issuer-not-authorized`.
- **Issuer rotation is history, as in #7.** A did:key cannot rotate, since a
  new key is a new DID, so an issuer's keys are listed in order with their
  windows. A key retired as `superseded` keeps validating what it signed before
  `retiredAt`, with a warning. Anything it signed afterwards is
  `retired-issuer-key`.
- **A compromised key invalidates everything, including the past.** `created`
  is written by the signer. A thief holding the old key can backdate it, so for
  a key marked `compromised` the verifier does not trust any date the key
  asserts.
- **The issuer must control the proving key.** A credential that names Example
  Studio as `issuer` but is signed by another key is `issuer-mismatch`.

## Status and revocation

Credentials carry a `BitstringStatusListEntry`. The list is itself a
credential (`BitstringStatusListCredential`) and is checked like one:

- its proof must verify, **and it must be signed by the credential's own
  issuer**. Otherwise anyone could serve an all-zero list for a revoked
  credential;
- its `id` must be the URL the entry names, its purpose must match, and it must
  not have expired;
- `encodedList` is multibase base64url of the GZIP-compressed bitstring. Index
  0 is the most significant bit of the first byte. Decompression is capped at
  16 MiB, because a few kilobytes of gzip can expand to gigabytes and the list
  comes from the network;
- a list shorter than **131,072 entries** is refused
  (`STATUS_LIST_LENGTH_ERROR`). The minimum is what gives holders a crowd to
  hide in when the list is fetched.

`revocation` → `rejected: revoked`; `suspension` → `rejected: suspended`.
The two are reported separately because one is permanent and the other is not.

**Fail closed.** If the status list cannot be fetched or does not verify, the
verdict is `rejected: status-unavailable`. A verifier that accepted during an
outage would accept every revoked credential during an outage, and an attacker
can cause outages. A policy may set `statusFailure: "warn"`, and the report
then says the status was not checked.

## Registry cross-check (#7)

The registry is the authority for creator identity and delegations. A
credential is a way to present them off-chain, and **may not claim more than
the chain does**. With a registry adapter (`getDelegation`, `getCreator`,
`getRecord`, all read-only queries), the verifier checks:

| Credential | Rejected (`registry-mismatch`) when |
| --- | --- |
| Delegated authority | the on-chain delegation does not exist, names another delegate or creator, grants a different scope, is revoked, has expired, or expires before the credential's `validUntil` |
| Membership | the named principal is not the creator's **current** root. A credential naming a rotated-away key describes who the creator was, and presenting it now would let the old key speak for the identity |
| Review | the record does not exist, or its hashes are not the reviewed ones. A review of a record revoked since then is accepted with a warning: it is still a true statement about what was reviewed |

So revoking a delegation on-chain revokes every credential that presents it,
with no status list involved. `tools/pocket-ic/vc.test.mjs` shows this against
app 01 on a replica. The unchanged credential is accepted, then rejected after
`revokeDelegation`. A two-day delegation is rejected once the replica clock
passes its expiry. A membership credential goes stale when the creator runs
`rotateKey`.

An unreachable registry is a warning, not a rejection. The credential's own
claims were verified, and the report says the chain was not consulted.

## Verification report

`tools/vc.mjs verify` returns `schemas/vc-verification-report.schema.json`:
one field per check (`proof`, `issuer`, `validity`, `status`, `registry`), a
verdict, and a machine-readable `reasons` list for rejections: `malformed`,
`invalid-proof`, `issuer-mismatch`, `issuer-not-authorized`,
`retired-issuer-key`, `compromised-issuer-key`, `expired`, `not-yet-valid`,
`revoked`, `suspended`, `status-unavailable`, `status-required`,
`registry-mismatch`.

| Verdict | Exit |
| --- | --- |
| `accepted` | 0 |
| `accepted-with-warnings` | 0 |
| `unknown-issuer` | 2 |
| `rejected` | 3 |

```bash
node protocol/tools/vc.mjs verify protocol/examples/vc/membership.json \
  --policy protocol/examples/vc/policy.json \
  --status-list https://studio.example/status/1=protocol/examples/vc/status-list.json
```

## Personal data minimization review

What each credential discloses, and why nothing more:

- **Membership** names the organization and a role, and identifies the member
  only by principal. No name, e-mail or employee number. The relying party
  needs "this key belongs to a member", not who the member is.
- **Delegation** names two principals and ids that already exist on-chain. It
  adds nothing personal that the registry does not already publish.
- **Review** names a record and two hashes. The reviewer's method is free
  text, and issuers should keep reviewer identities out of it.
- **Status lists** reveal nothing per holder: the 131,072-entry minimum and a
  random index assignment (the issuer's responsibility) make a fetch
  uninformative. Issuers should not assign indexes sequentially by issuance
  time, since that would leak when a credential was issued.
- **Registry cross-checks** are queries against public state. They reveal to
  the registry, and to whoever sees the query, only that someone is checking
  that delegation. A verifier worried about that can check against a saved
  certified snapshot instead.
- **Credentials never go on-chain.** The registry stores delegations and keys,
  not credentials, so there is nothing to erase from an immutable ledger when
  someone leaves an organization.
- **Correlation remains.** A principal is a stable identifier, and presenting
  two credentials for the same principal links them. That is inherent in
  principal-based identity and is the main argument for the selective
  disclosure work below.

## Selective disclosure (research, not implemented)

`eddsa-jcs-2022` signs the whole credential, so a holder must present all of
it. Three standards could change that:

- **SD-JWT VC.** SD-JWT is RFC 9901 (November 2025). The issuer replaces
  disclosable claims with salted digests and the holder reveals chosen salts.
  It is mature and widely deployed (EUDI wallets), but it is a JWT format, not
  a Data Integrity proof. Adopting it means a second credential format beside
  this one, not a new cryptosuite.
- **`ecdsa-sd-2023`** (Data Integrity ECDSA Cryptosuites v1.0, Recommendation).
  Selective disclosure within Data Integrity, but it requires RDF
  canonicalization, which gives up the single-canonical-form argument above.
- **`bbs-2023`** (Data Integrity BBS Cryptosuites, a Candidate Recommendation
  Draft as of September 2026, waiting on the IETF BBS signature
  specification). It is the only option that is **unlinkable**: two
  presentations of the same credential cannot be correlated. That addresses
  the correlation problem above, and nothing else here does. It is also not
  final.

Recommendation: stay on `eddsa-jcs-2022` for credentials that carry nothing
worth hiding, which is all three types here. Revisit when a credential type
needs attributes a holder would want to withhold, choosing SD-JWT VC for
deployability or `bbs-2023` once it is a Recommendation.

## Files

| Path | What |
| --- | --- |
| `tools/multikey.mjs` | base58-btc, multibase, Ed25519 Multikey, did:key |
| `tools/vc.mjs` | eddsa-jcs-2022, Bitstring Status List, builders, policy verification, CLI |
| `tools/vc-example.mjs` | builds `examples/vc/` |
| `tools/vc.test.mjs` | offline suite, in `scripts/run_offline_checks.sh` |
| `../tools/pocket-ic/vc.test.mjs` | cross-check against app 01 on pocket-ic, in the Replica workflow |
| `test-vectors/vc/eddsa-jcs-2022.json` | the W3C Recommendation's vector |
| `schemas/vc-verification-report.schema.json` | the report |
