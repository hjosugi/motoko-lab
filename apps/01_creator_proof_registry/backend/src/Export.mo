/// The portable export format: versioned pages, per-entry digests, and the
/// roots that bind a streamed export to one snapshot.
///
/// A canister's state survives crashes because the subnet replicates it; that
/// is not the same as being able to *leave*. An export has to be checkable by
/// someone who does not trust the tool that fetched it, resumable after the
/// connection drops, and narrow enough that a private pointer can be left out
/// without invalidating everything else. This module is the canister side of
/// that contract; `tools/export/format.mjs` is the independent reader.
///
/// The layout follows the same discipline as `RecordDigest.mo` and
/// `protocol/COMMITMENT_V1.md`: a versioned domain separator, fixed-width
/// big-endian integers, a length prefix on every variable-length field, a
/// present-flag on every optional, and a tag byte on every variant. Every
/// digest is SHA-256 over those bytes, and the roots are over the ordered
/// digests, so two exports of the same state produce the same bytes whatever
/// page size was used to fetch them.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import RecordDigest "RecordDigest";
import Validation "Validation";

module {
  /// A new layout gets a new domain string rather than an edit to this one.
  public let formatV1 : Text = "icp-creator-proof:export:v1";

  public let commitmentDomainV1 : Text = "icp-creator-proof:export-commitment:v1";
  public let commitmentRootDomainV1 : Text = "icp-creator-proof:export-commitments-root:v1";
  public let recordRootDomainV1 : Text = "icp-creator-proof:export-records-root:v1";
  public let pageDomainV1 : Text = "icp-creator-proof:export-page:v1";

  /// Page kinds, as they appear in a page checksum.
  public let commitmentKind : Nat8 = 1;
  public let recordKind : Nat8 = 2;

  /// The same cap `Validation.pageLimit` enforces, restated for the tooling.
  public let pageMax : Nat = 100;

  /// What the exporter is allowed to include. `includeStorageUris = false`
  /// replaces every record's `storageUri` with the empty text *before* the
  /// digests are computed, so a redacted export is self-consistent: its roots
  /// describe what was actually handed out, and a reader can say exactly what
  /// the redaction was. Restoring a redacted export restores the redaction,
  /// not the pointer.
  public type Policy = {
    includeStorageUris : Bool;
  };

  public type CommitmentStatus = {
    #open;
    #revealed : Nat;
    #cancelled : Nat;
  };

  public type Commitment = {
    id : Nat;
    owner : Principal;
    commitmentHash : Blob;
    metadataHash : ?Blob;
    committedAt : Nat;
    expiresAt : ?Nat;
    status : CommitmentStatus;
  };

  /// What `exportSummary` returns: the snapshot's identity, its counts, and
  /// the two roots a reader recomputes from the pages.
  public type Summary = {
    format : Text;
    canister : Principal;
    policy : Policy;
    commitments : Nat;
    records : Nat;
    activeRecords : Nat;
    revokedRecords : Nat;
    commitmentRoot : Blob;
    recordRoot : Blob;
  };

  /// One bounded page of commitments. `next` is the id the next page starts
  /// at, or `null` when this page reached the end; the checksum covers the
  /// policy, the range, every entry digest and `next`, so a page cannot be
  /// replayed at another offset or under another policy.
  public type CommitmentPage = {
    kind : Nat8;
    start : Nat;
    next : ?Nat;
    checksum : Blob;
    entries : [Commitment];
  };

  public type RecordPage = {
    kind : Nat8;
    start : Nat;
    next : ?Nat;
    checksum : Blob;
    entries : [RecordDigest.Record];
  };

  // ------------------------------------------------------------------ policy

  public func redact(value : RecordDigest.Record, policy : Policy) : RecordDigest.Record {
    if (policy.includeStorageUris) {
      value
    } else {
      let redacted = { value with storageUri = "" };
      redacted
    }
  };

  // ---------------------------------------------------------------- digests

  /// The commitment's canonical digest. Mirrors `commitmentDomainV1` in
  /// `tools/export/format.mjs`; the replica suite compares the two live.
  public func commitmentDigest(commitment : Commitment) : Blob {
    let out = List.empty<Nat8>();
    RecordDigest.appendBlob(out, Text.encodeUtf8(commitmentDomainV1));
    RecordDigest.append(out, 0);
    RecordDigest.appendAll(out, RecordDigest.u64(commitment.id));
    RecordDigest.appendShort(out, Principal.toBlob(commitment.owner));
    RecordDigest.appendBlob(out, commitment.commitmentHash);
    appendOptionalBlob(out, commitment.metadataHash);
    RecordDigest.appendAll(out, RecordDigest.u64(commitment.committedAt));
    appendOptionalNat(out, commitment.expiresAt);
    switch (commitment.status) {
      case (#open) RecordDigest.append(out, 0);
      case (#revealed(recordId)) {
        RecordDigest.append(out, 1);
        RecordDigest.appendAll(out, RecordDigest.u64(recordId))
      };
      case (#cancelled(at)) {
        RecordDigest.append(out, 2);
        RecordDigest.appendAll(out, RecordDigest.u64(at))
      };
    };
    Sha256.fromBlob(#sha256, Array_toBlob(out))
  };

  /// The digest of a record **under the policy**, which is what the root and
  /// the page checksums use.
  public func recordDigest(record : RecordDigest.Record, policy : Policy) : Blob {
    RecordDigest.digest(redact(record, policy))
  };

  /// SHA-256 over the ordered entry digests, with the count folded in. A root
  /// is not a Merkle root: nothing here proves membership of one entry without
  /// the others. What it proves is that the reader has exactly the set the
  /// canister summarised, in id order — which is what "the restore matches"
  /// means.
  public func commitmentRoot(digests : [Blob]) : Blob {
    root(commitmentRootDomainV1, digests)
  };

  public func recordRoot(digests : [Blob]) : Blob {
    root(recordRootDomainV1, digests)
  };

  func root(domain : Text, digests : [Blob]) : Blob {
    let out = List.empty<Nat8>();
    RecordDigest.appendBlob(out, Text.encodeUtf8(domain));
    RecordDigest.append(out, 0);
    RecordDigest.appendAll(out, RecordDigest.u64(digests.size()));
    for (digest in digests.values()) RecordDigest.appendBlob(out, digest);
    Sha256.fromBlob(#sha256, Array_toBlob(out))
  };

  /// The page checksum, over the same entry digests the reader recomputes.
  public func pageChecksum(
    kind : Nat8,
    policy : Policy,
    start : Nat,
    next : ?Nat,
    digests : [Blob]
  ) : Blob {
    let out = List.empty<Nat8>();
    RecordDigest.appendBlob(out, Text.encodeUtf8(pageDomainV1));
    RecordDigest.append(out, 0);
    RecordDigest.append(out, kind);
    RecordDigest.append(out, if (policy.includeStorageUris) 1 else 0);
    RecordDigest.appendAll(out, RecordDigest.u64(start));
    RecordDigest.appendAll(out, RecordDigest.u32(digests.size()));
    for (digest in digests.values()) RecordDigest.appendBlob(out, digest);
    switch (next) {
      case null RecordDigest.append(out, 0);
      case (?value) {
        RecordDigest.append(out, 1);
        RecordDigest.appendAll(out, RecordDigest.u64(value))
      };
    };
    Sha256.fromBlob(#sha256, Array_toBlob(out))
  };

  // ------------------------------------------------------------- validation

  /// What a commitment must look like to be accepted by a restore. The same
  /// bounds `commit` enforces, plus the status the export carried: a restore
  /// preserves `#revealed` and `#cancelled` rather than replaying the calls
  /// that produced them.
  public func checkCommitment(commitment : Commitment) : ?Text {
    if (Principal.isAnonymous(commitment.owner)) return ?"commitment owner is anonymous";
    if (not Validation.isDigest(commitment.commitmentHash)) return ?"commitmentHash must be 32 bytes";
    switch (commitment.metadataHash) {
      case (?hash) { if (not Validation.isDigest(hash)) return ?"metadataHash must be 32 bytes" };
      case null {};
    };
    switch (commitment.status) {
      case (#revealed(recordId)) { if (recordId == 0) return ?"revealed record id is zero" };
      case _ {};
    };
    null
  };

  /// What a record must look like to be accepted by a restore. `storageUri`
  /// may be empty here, because a redacted export replaces it: refusing it
  /// would make the redaction policy unusable.
  public func checkRecord(record : RecordDigest.Record) : ?Text {
    if (Principal.isAnonymous(record.owner)) return ?"record owner is anonymous";
    if (record.commitmentId == 0) return ?"commitmentId is zero";
    if (not Validation.isDigest(record.artifactHash)) return ?"artifactHash must be 32 bytes";
    if (not Validation.isDigest(record.manifestHash)) return ?"manifestHash must be 32 bytes";
    if (not Validation.validSalt(record.salt)) return ?"salt must be between 16 and 64 bytes";
    if (not Validation.validText(record.title, 1, 200)) return ?"title length is invalid";
    if (not Validation.validText(record.kind, 1, 100)) return ?"kind length is invalid";
    if (not Validation.validText(record.mimeType, 1, 100)) return ?"mimeType length is invalid";
    if (record.storageUri.size() > 2048) return ?"storageUri length is invalid";
    if (record.parents.size() > 32) return ?"parents must contain at most 32 records";
    switch (record.ai.promptHash) {
      case (?hash) { if (not Validation.isDigest(hash)) return ?"promptHash must be 32 bytes" };
      case null {};
    };
    switch (record.ai.provider) {
      case (?value) { if (not Validation.validText(value, 1, 100)) return ?"AI provider length is invalid" };
      case null {};
    };
    switch (record.ai.model) {
      case (?value) { if (not Validation.validText(value, 1, 100)) return ?"AI model length is invalid" };
      case null {};
    };
    switch (record.ai.humanContribution) {
      case (?value) { if (not Validation.validText(value, 1, 1000)) return ?"humanContribution length is invalid" };
      case null {};
    };
    switch (record.status) {
      case (#revoked(revocation)) {
        if (not Validation.validText(revocation.reason, 1, 1000)) return ?"revocation reason length is invalid"
      };
      case (#active) {};
    };
    null
  };

  // -------------------------------------------------------------- primitives

  func appendOptionalBlob(out : List.List<Nat8>, value : ?Blob) {
    switch (value) {
      case null RecordDigest.append(out, 0);
      case (?bytes) {
        RecordDigest.append(out, 1);
        RecordDigest.appendBlob(out, bytes)
      }
    }
  };

  func appendOptionalNat(out : List.List<Nat8>, value : ?Nat) {
    switch (value) {
      case null RecordDigest.append(out, 0);
      case (?number) {
        RecordDigest.append(out, 1);
        RecordDigest.appendAll(out, RecordDigest.u64(number))
      }
    }
  };

  // `List.toArray` is used through this alias so the module reads like the
  // others; it is the only array conversion in this file.
  func Array_toBlob(list : List.List<Nat8>) : Blob {
    Array.toBlob(List.toArray(list))
  };
};
