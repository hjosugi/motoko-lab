# Certified queries

Issue #6. `getRecord` is a query. A query response is not signed by the subnet,
so anything between the canister and the reader — a boundary node, a proxy, a
compromised frontend — can change any field of it, and nothing downstream can
tell. For a registry whose entire product is "this record says what the creator
committed to", that is the wrong trust model to ship.

`getRecordCertified` returns the record together with the evidence that the
canister produced it.

## What the reader does

```
1. Certificate.create(certificate, rootKey, canisterId)
     verifies the BLS signature over the state tree and any subnet delegation
2. lookup /canister/<id>/certified_data in that certified tree
     the only 32 bytes the subnet signed for this canister
3. reconstruct(witness)
     its root MUST equal those 32 bytes
4. lookup ["record", id] in the witness
     that value MUST equal SHA-256(RecordDigest.encode(record))
```

Step 3 is the one that is easy to leave out and fatal to leave out. A witness
that reconstructs internally but whose root is not the certified data describes
some *other* tree; a reader that checked only "the certificate verifies" and
"the witness contains a digest" would accept a forgery. The replica suite has a
vector for exactly that — a witness captured before a mutation, presented with
the current certificate — and it fails at step 3, not anywhere else.

The reference reader is `tools/pocket-ic/certificate.mjs`. The record encoding a
reader needs is `test/record-digest.mjs`, deliberately a second implementation:
a verifier that asked the canister for the digest would be verifying nothing.

## What is certified

The digest covers **every field of the record**. A certification that covered
only the identity would leave `storageUri` — the field that says where the
artifact actually is — alterable without detection, which is precisely the
substitution a provenance registry exists to prevent.

Status is covered too. Revocation that an intermediary could suppress, by
continuing to serve the record as active, would be cosmetic.

The encoding is `backend/src/RecordDigest.mo`, under the same discipline as the
commitment in `protocol/COMMITMENT_V1.md`: a versioned domain separator, fixed
width integers, and a length prefix on every variable-length field.

```
encoding = domain %x00 fixed-fields variable-fields status

domain        = %s"icp-creator-proof:record:v1"
id            = 8OCTET                  ; big-endian
commitmentId  = 8OCTET                  ; big-endian
owner         = OCTET *29OCTET          ; one length octet, then the principal blob
artifactHash  = 32OCTET
manifestHash  = 32OCTET
salt          = OCTET 16*64OCTET        ; one length octet, then the salt
title         = 4OCTET *OCTET           ; u32 big-endian length, then UTF-8
kind          = 4OCTET *OCTET
mimeType      = 4OCTET *OCTET
storageUri    = 4OCTET *OCTET
parents       = 4OCTET *8OCTET          ; u32 count, then each id big-endian
ai            = assisted mode provider model promptHash humanContribution
status        = %x00 / (%x01 revokedAt reason)
```

`assisted` is one octet. `mode` is a tag octet — `none`/`assist`/`generate`/
`transform`/`other` as 0..4 — followed by a length-prefixed string for `other`.
Each optional field is a present-flag octet followed, when present, by the
value. A flag rather than a zero length, so an absent `provider` and a
`provider` of `""` cannot encode alike.

`RecordDigest.idKey` is the id as eight big-endian octets, so the tree's
byte-wise label order matches numeric order.

The tree path is `["record", idKey]`. Keeping records under their own label
leaves room to certify something else later without moving what is already
certified.

## Fallback to update calls

Certified queries do not cover everything, and the honest fallback is an update
call, which is answered by consensus and needs no certificate at all:

- **Absence.** `getRecordCertified` returns `null` for an unknown id, and that
  `null` is not certified. A witness can prove absence, but the canister does
  not build one here; a reader that needs a proven absence should call the
  method as an update.
- **Freshness within the round.** `setCertifiedData` publishes the root, but
  the root is only signed once the round ends. A query issued in the same round
  as the write can still see the previous certificate. A reader that needs the
  value as of *now* uses an update call.
- **Everything except records.** `getCommitment`, `listRecords`, `stats` and
  `getByArtifactHash` are uncertified. `listRecords` and `stats` are aggregates
  a witness would have to be rebuilt for on every mutation;
  `getByArtifactHash` is an index into records that are themselves certified,
  so a reader can follow it with `getRecordCertified` and verify the answer it
  landed on. `getCommitment` is future work — a commitment is a promise about a
  record that does not exist yet, and the record it becomes is certified.

## Cost

`mops bench --replica pocket-ic` (pocket-ic 14.0.0, moc 1.11.1), instructions,
by number of records already in the tree:

| | 10 | 1000 | 10000 |
| :--- | ---: | ---: | ---: |
| `digest` | 550_749 | 551_375 | 551_343 |
| `put` | 329_433 | 611_177 | 539_239 |
| `digest+put` | 882_493 | 1_164_221 | 1_092_267 |

So certification adds roughly 0.9M to 1.2M instructions to a `reveal` or a
`revokeRecord` — an order of magnitude more than the commitment check's ~100k
(`docs/COMMITMENT_V1.md`), and the dominant cost of both endpoints. Nothing is
paid on the read side beyond building the witness.

`put` is not monotonic in the record count, and that is not noise. The tree is a
radix trie over the id bytes, so the depth of an insertion is set by where the
new key diverges from the keys already there, not by how many there are. Id
1000 happens to sit deeper relative to its neighbours than id 10000 does. The
figures above insert the *next sequential id*, which is what `reveal` actually
does; measuring a far-away id instead gives a flat ~257k across all three
columns, because such a key diverges in the first byte and the insert is
shallow. That number would have been meaningless.

## Dependency

| | |
|---|---|
| Package | [`ic-certification`](https://mops.one/ic-certification) 1.1.0 |
| Source | https://github.com/nomeata/ic-certification |
| Used | `CertTree` — hash tree, witness pruning, CBOR encoding |

The hash tree, the pruning rules and the CBOR encoding are all specified by the
Interface Specification and all easy to get subtly wrong, and a wrong witness is
a client that accepts forged data without complaint. The package is written by
the author of that part of the specification. Same reasoning as `mo:sha2` in
`docs/COMMITMENT_V1.md`.

The cost is larger here and worth stating plainly: it brings `base`, `cbor`,
`buffer`, `xtended-numbers`, and its own major versions of `core` and `sha2`
alongside the app's. Mops keeps them apart — `core@1` and `sha2@0` against our
unqualified `core` and `sha2` — and both `scripts/check_candid_compat.py` and
`tools/pocket-ic/harness.mjs` now ask `mops sources` for the package path rather
than deriving it from directory names, which stops being correct the moment one
package is installed at two major versions.

## Evidence

`node tools/pocket-ic/run.mjs 01`, pocket-ic 14.0.0. The certified paths are
verified against the subnet's own public key, obtained from the replica rather
than from the response — verifying against a key taken from the thing being
verified would prove nothing.

| Case | Result |
|---|---|
| valid witness | the attested digest equals the locally recomputed one |
| record with a rewritten `storageUri` | no longer matches |
| record with a rewritten `title` | no longer matches |
| revoked record presented as active | no longer matches |
| corrupted witness | rejected, before any comparison |
| witness from before the last mutation | rejected: its root is not the certified data |
| unknown record | no certificate returned |
| after an upgrade | a record certified before it still verifies |

`test/RecordDigest.test.mo` pins the encoding byte for byte in the interpreter,
against a vector produced by the JavaScript implementation, and asserts that
each field changed on its own changes the digest.

## Still open

- Certifying `getCommitment`, and building absence proofs rather than pointing
  at update calls.
- A browser reader. `tools/pocket-ic/certificate.mjs` is the verification logic
  and runs on Node; the frontend that would use it is #26.
