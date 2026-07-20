# Data Model and API Review

## Core entities

- Commitment
- ProofRecord
- DerivationEdge
- Revocation
- IdentityCredentialReference
- LicenseListing
- LicenseGrant
- BatchAnchor
- VerificationReport

## ID strategy

monotonic Nat IDはpaginationとdebugに有用です。cross-registryでは`canister principal + record ID`をglobal referenceにします。

## Hash fields

hash fieldにはalgorithm/versionをschemaで固定します。将来のalgorithm agilityでは次の形へ移行します。

```motoko
type Digest = {
  algorithm : { #sha256; #sha512_256; #other : Text };
  bytes : Blob;
};
```

MVPは32-byte SHA-256 assumptionを使用します。

## Public API principles

- bounded list
- typed errors
- no secret return
- immutable historical object
- separate mutation for revoke/correct
- method deprecation period
- idempotency on financial/external flows

## Query model

current record lookupはqueryでよいですが、high-assurance verifierはcertificateを検証するかupdate pathを使います。

## Export

exportには次を含めます。

- canister ID
- module hash/version
- Candid version
- record payload
- commitment payload
- manifest and artifact digest
- verification timestamp
- certificate/proof when available
- source URLs and policy version
