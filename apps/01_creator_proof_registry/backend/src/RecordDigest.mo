/// The canonical byte encoding of a proof record, and its digest.
///
/// A query response can be altered by whatever sits between the canister and
/// the reader — a boundary node, a proxy, a compromised frontend. `getRecord`
/// is a query, so nothing about its answer is signed, and a reader who trusts
/// it is trusting the transport. That is the gap issue #6 closes: the canister
/// certifies a digest of every record, and a reader recomputes the digest from
/// the record it was handed. If the two disagree, the record was altered in
/// transit.
///
/// The digest covers **every field**, not a summary. A certification that
/// covered only the identity would leave `storageUri` — the field that says
/// where the artifact actually is — alterable without detection, which is
/// exactly the substitution a provenance registry exists to prevent.
///
/// The layout follows the same discipline as the commitment in
/// `protocol/COMMITMENT_V1.md`: a versioned domain separator, fixed-width
/// integers, and a length prefix on every variable-length field, so no two
/// distinct records can encode to the same bytes. `docs/CERTIFIED_QUERIES.md`
/// has the byte-level grammar and the conformance vectors.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";

module {
  public type AIDisclosure = {
    assisted : Bool;
    mode : { #none; #assist; #generate; #transform; #other : Text };
    provider : ?Text;
    model : ?Text;
    promptHash : ?Blob;
    humanContribution : ?Text;
  };

  public type RecordStatus = {
    #active;
    #revoked : { at : Nat; reason : Text };
  };

  public type Record = {
    id : Nat;
    commitmentId : Nat;
    owner : Principal;
    artifactHash : Blob;
    manifestHash : Blob;
    salt : Blob;
    title : Text;
    kind : Text;
    mimeType : Text;
    storageUri : Text;
    parents : [Nat];
    ai : AIDisclosure;
    createdAt : Nat;
    status : RecordStatus;
  };

  /// A new layout gets a new domain string rather than an edit to this one, so
  /// a v1 encoding can never be reinterpreted under v2 rules.
  public let domainV1 : Text = "icp-creator-proof:record:v1";

  public let version : Text = "v1";

  /// The tree label every record digest lives under. Keeping records in their
  /// own subtree leaves room for other certified data later without moving
  /// what is already certified.
  public let treeLabel : Blob = "record";

  /// Big-endian, so the tree's byte-wise label order matches numeric order and
  /// a range proof over ids would stay meaningful.
  public func idKey(id : Nat) : Blob {
    Array.toBlob(u64(id))
  };

  public func digest(record : Record) : Blob {
    Sha256.fromBlob(#sha256, encode(record))
  };

  /// Exposed separately from `digest` so the conformance vectors can pin the
  /// bytes that get hashed, not only the hash.
  public func encode(record : Record) : Blob {
    let out = List.empty<Nat8>();

    // The domain is fixed-length and known, so it needs no prefix.
    appendBlob(out, Text.encodeUtf8(domainV1));
    append(out, 0);

    appendAll(out, u64(record.id));
    appendAll(out, u64(record.commitmentId));

    // A principal blob is at most 29 bytes, so one length byte is enough.
    appendShort(out, Principal.toBlob(record.owner));

    // Both are exactly 32 bytes, enforced on the way in by `Validation`.
    appendBlob(out, record.artifactHash);
    appendBlob(out, record.manifestHash);
    // 16..64 bytes.
    appendShort(out, record.salt);

    appendText(out, record.title);
    appendText(out, record.kind);
    appendText(out, record.mimeType);
    appendText(out, record.storageUri);

    appendAll(out, u32(record.parents.size()));
    for (parent in record.parents.values()) {
      appendAll(out, u64(parent))
    };

    appendDisclosure(out, record.ai);

    appendAll(out, u64(record.createdAt));

    switch (record.status) {
      case (#active) append(out, 0);
      case (#revoked(revocation)) {
        append(out, 1);
        appendAll(out, u64(revocation.at));
        appendText(out, revocation.reason)
      }
    };

    Array.toBlob(List.toArray(out))
  };

  func appendDisclosure(out : List.List<Nat8>, ai : AIDisclosure) {
    append(out, if (ai.assisted) 1 else 0);
    switch (ai.mode) {
      case (#none) append(out, 0);
      case (#assist) append(out, 1);
      case (#generate) append(out, 2);
      case (#transform) append(out, 3);
      case (#other(value)) {
        append(out, 4);
        appendText(out, value)
      }
    };
    appendOptionalText(out, ai.provider);
    appendOptionalText(out, ai.model);
    switch (ai.promptHash) {
      case null append(out, 0);
      case (?hash) {
        append(out, 1);
        appendBlob(out, hash)
      }
    };
    appendOptionalText(out, ai.humanContribution)
  };

  // A present-flag rather than a zero length, so "absent" and "present but
  // empty" cannot encode to the same bytes.
  func appendOptionalText(out : List.List<Nat8>, value : ?Text) {
    switch (value) {
      case null append(out, 0);
      case (?text) {
        append(out, 1);
        appendText(out, text)
      }
    }
  };

  func appendText(out : List.List<Nat8>, value : Text) {
    let bytes = Text.encodeUtf8(value);
    appendAll(out, u32(bytes.size()));
    appendBlob(out, bytes)
  };

  func appendShort(out : List.List<Nat8>, value : Blob) {
    append(out, Nat.toNat8(value.size()));
    appendBlob(out, value)
  };

  func append(out : List.List<Nat8>, byte : Nat8) {
    List.add(out, byte)
  };

  func appendAll(out : List.List<Nat8>, bytes : [Nat8]) {
    for (byte in bytes.values()) List.add(out, byte)
  };

  func appendBlob(out : List.List<Nat8>, value : Blob) {
    for (byte in Blob.toArray(value).values()) List.add(out, byte)
  };

  func u64(value : Nat) : [Nat8] {
    let wide = Nat.toNat64(value);
    Iter.toArray(
      Iter.map<Nat, Nat8>(
        Nat.range(0, 8),
        func(index : Nat) : Nat8 {
          byteOf(wide, 7 - index)
        }
      )
    )
  };

  func u32(value : Nat) : [Nat8] {
    let wide = Nat.toNat64(value);
    Iter.toArray(
      Iter.map<Nat, Nat8>(
        Nat.range(0, 4),
        func(index : Nat) : Nat8 {
          byteOf(wide, 3 - index)
        }
      )
    )
  };

  // Masked before narrowing: `Nat64.toNat8` narrows through Nat32 and Nat16,
  // and those conversions trap rather than truncate, so shifting alone is not
  // enough for anything above the low byte.
  func byteOf(value : Nat64, index : Nat) : Nat8 {
    Nat64.toNat8(Nat64.bitand(Nat64.bitshiftRight(value, Nat.toNat64(index * 8)), 0xFF))
  };
};
