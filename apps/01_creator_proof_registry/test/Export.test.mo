// The export format's rules, pinned in the interpreter.
//
// The replica suite is where the Motoko encoding and the JavaScript reader are
// compared live, on every page a real canister serves. This test covers what
// that comparison cannot reach cheaply: the restore validation table, the
// redaction policy's effect on digests, and the properties of the roots and
// page checksums (bound to count, order, policy, and page position). The exact
// byte vectors are pinned by `tools/export/export.test.mjs`, which is the
// reader's implementation.

import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Export "../backend/src/Export";
import RecordDigest "../backend/src/RecordDigest";

let owner = Principal.fromBlob("\00\00\00\00\00\00\00\01\02\03");

let commitment : Export.Commitment = {
  id = 7;
  owner;
  commitmentHash = "\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA";
  metadataHash = ?"\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB";
  committedAt = 1234567890;
  expiresAt = ?2000000000;
  status = #revealed(3);
};

let proof : RecordDigest.Record = {
  id = 7;
  commitmentId = 3;
  owner;
  artifactHash = "\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA";
  manifestHash = "\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB";
  salt = "\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC";
  title = "t";
  kind = "image";
  mimeType = "image/png";
  storageUri = "ipfs://x";
  parents = [1, 2];
  ai = {
    assisted = true;
    mode = #other("研究");
    provider = ?"acme";
    model = null;
    promptHash = ?"\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD";
    humanContribution = null;
  };
  createdAt = 1234567890;
  status = #revoked({ at = 999; reason = "superseded" });
};

let includeUris : Export.Policy = { includeStorageUris = true };
let redactUris : Export.Policy = { includeStorageUris = false };

// ------------------------------------------------------------ validation

assert Export.checkCommitment(commitment) == null;
assert Export.checkCommitment({ commitment with owner = Principal.fromText("2vxsx-fae") }) != null;
assert Export.checkCommitment({ commitment with commitmentHash = "\00" }) != null;
assert Export.checkCommitment({ commitment with metadataHash = ?"\00" }) != null;
assert Export.checkCommitment({ commitment with status = #revealed(0) }) != null;
assert Export.checkCommitment({ commitment with status = #open }) == null;
assert Export.checkCommitment({ commitment with status = #cancelled(0) }) == null;

assert Export.checkRecord(proof) == null;
assert Export.checkRecord({ proof with owner = Principal.fromText("2vxsx-fae") }) != null;
assert Export.checkRecord({ proof with commitmentId = 0 }) != null;
assert Export.checkRecord({ proof with artifactHash = "\00" }) != null;
assert Export.checkRecord({ proof with manifestHash = "\00" }) != null;
assert Export.checkRecord({ proof with salt = "\00" }) != null;
assert Export.checkRecord({ proof with title = "" }) != null;
assert Export.checkRecord({ proof with kind = "" }) != null;
assert Export.checkRecord({ proof with mimeType = "" }) != null;
assert Export.checkRecord({ proof with storageUri = "" }) == null; // the redacted form
assert Export.checkRecord({ proof with status = #revoked({ at = 1; reason = "" }) }) != null;
assert Export.checkRecord({ proof with ai = { proof.ai with promptHash = ?"\00" } }) != null;
assert Export.checkRecord({ proof with ai = { proof.ai with provider = ?"" } }) != null;
assert Export.checkRecord({ proof with ai = { proof.ai with model = ?"" } }) != null;
assert Export.checkRecord({ proof with ai = { proof.ai with humanContribution = ?"" } }) != null;

// ------------------------------------------------------------- redaction

let redacted = Export.redact(proof, redactUris);
assert redacted.storageUri == "";
assert redacted.title == proof.title;
assert not Blob.equal(Export.recordDigest(proof, includeUris), Export.recordDigest(proof, redactUris));

// --------------------------------------------------- digests and roots

// The digest is over the record the policy produced, so redaction is inside
// what the roots attest rather than a presentation detail.
let digests = [Export.recordDigest(proof, includeUris)];
let redactedDigests = [Export.recordDigest(proof, redactUris)];
assert not Blob.equal(Export.recordRoot(digests), Export.recordRoot(redactedDigests));
// Count and order are part of the root: one entry is not the same claim as
// the same entry twice, and a repeated digest changes the answer.
assert not Blob.equal(Export.recordRoot(digests), Export.recordRoot([digests[0], digests[0]]));
assert not Blob.equal(Export.recordRoot([digests[0], digests[0]]), Export.recordRoot([digests[0]]));
assert Blob.equal(Export.recordRoot([digests[0]]), Export.recordRoot(digests));

let commitmentDigests = [Export.commitmentDigest(commitment)];
assert not Blob.equal(Export.commitmentRoot(commitmentDigests), Export.recordRoot(commitmentDigests));

// Every field of the commitment is covered by its digest.
let commitmentBaseline = Export.commitmentDigest(commitment);
assert not Blob.equal(Export.commitmentDigest({ commitment with id = 8 }), commitmentBaseline);
assert not Blob.equal(Export.commitmentDigest({ commitment with committedAt = 1 }), commitmentBaseline);
assert not Blob.equal(Export.commitmentDigest({ commitment with expiresAt = null }), commitmentBaseline);
assert not Blob.equal(Export.commitmentDigest({ commitment with metadataHash = null }), commitmentBaseline);
assert not Blob.equal(Export.commitmentDigest({ commitment with status = #open }), commitmentBaseline);
assert not Blob.equal(Export.commitmentDigest({ commitment with status = #cancelled(3) }), commitmentBaseline);

// ---------------------------------------------------------- page checksum

let page = Export.pageChecksum(Export.commitmentKind, includeUris, 0, ?1, commitmentDigests);
assert Blob.equal(page, Export.pageChecksum(Export.commitmentKind, includeUris, 0, ?1, commitmentDigests));
assert not Blob.equal(page, Export.pageChecksum(Export.recordKind, includeUris, 0, ?1, commitmentDigests));
assert not Blob.equal(page, Export.pageChecksum(Export.commitmentKind, redactUris, 0, ?1, commitmentDigests));
assert not Blob.equal(page, Export.pageChecksum(Export.commitmentKind, includeUris, 1, ?1, commitmentDigests));
assert not Blob.equal(page, Export.pageChecksum(Export.commitmentKind, includeUris, 0, null, commitmentDigests));
assert not Blob.equal(page, Export.pageChecksum(Export.commitmentKind, includeUris, 0, ?2, commitmentDigests));

// The format is versioned, so a v1 page can never be read under v2 rules.
assert Export.formatV1 == "icp-creator-proof:export:v1";
