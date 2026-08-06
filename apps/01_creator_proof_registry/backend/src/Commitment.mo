/// The v1 commit-reveal commitment, recomputed on-chain.
///
/// Before this module the canister stored `commitmentHash` and the revealed
/// principal, manifest hash and salt side by side without ever checking that
/// the second set produces the first. Anyone could commit to one digest and
/// reveal something unrelated; the registry would happily record it and only an
/// off-chain verifier running `provenance-cli verify-commitment` would notice.
///
/// The preimage layout is the one `protocol/tools/provenance-cli.mjs` already
/// implements, so the Node verifier and the canister agree byte for byte:
///
///     SHA-256( domain || 0x00 || principalText || 0x00 || manifestHash || 0x00 || salt )
///
/// Every field is fixed length or terminated by the 0x00 separator, and 0x00
/// cannot occur inside any of them: `domain` is a fixed ASCII literal,
/// `principalText` is base32 with dashes, and `manifestHash` is exactly 32
/// bytes. So no two distinct field triples can concatenate to the same
/// preimage. `protocol/test-vectors/test-vectors.json` pins the layout with
/// cross-language vectors.
///
/// The commitment hash is public - it is stored on-chain and returned by
/// `getCommitment` - so `matches` compares with ordinary structural equality.
/// There is no secret whose comparison time could leak.
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import Sha256 "mo:sha2/Sha256";

module {
  /// Identifies both the hash function and the preimage layout, so a future
  /// layout can be added without redefining what `#sha256V1` meant.
  ///
  /// Nothing needs to record which algorithm a commitment used. The algorithm
  /// selects the preimage, the preimage determines the digest, and the digest
  /// is what `commit` stored - so a reveal that names the wrong algorithm
  /// fails the same comparison as a reveal that names the wrong salt. The
  /// choice is self-authenticating and stays out of stable state.
  public type Algorithm = {
    #sha256V1;
  };

  /// What a caller gets when it asks the canister which layouts it accepts.
  /// Mirrors `spec()` in `protocol/tools/commitment.mjs`, so a verifier can
  /// rebuild the preimage from this record alone rather than from a document
  /// it hopes matches the deployed canister.
  public type Spec = {
    version : Text;
    algorithm : Algorithm;
    domain : Text;
    layout : Text;
    digestSize : Nat;
    minSaltSize : Nat;
    maxSaltSize : Nat;
    minPrincipalTextSize : Nat;
    maxPrincipalTextSize : Nat;
  };

  /// The three values the commitment binds together.
  public type Parts = {
    principalText : Text;
    manifestHash : Blob;
    salt : Blob;
  };

  public let currentAlgorithm : Algorithm = #sha256V1;

  public let version : Text = "v1";

  /// ASCII, and deliberately versioned: a v2 layout gets a new domain string so
  /// a v1 preimage can never be reinterpreted under v2 rules.
  public let domainV1 : Text = "icp-creator-proof:v1";

  public let layoutV1 : Text = "domain-zero-principalText-zero-manifestDigest-zero-salt";

  public let digestSize : Nat = 32;

  /// The full range of the principal textual form: a principal blob is 0 to 29
  /// bytes, and CRC32 prefixing plus unpadded base32 in five-character groups
  /// turns that into 8 characters (`aaaaa-aa`, the empty blob) through 63.
  ///
  /// `Principal.toText` never returns anything outside this range, so on-chain
  /// the check is a defensive assertion rather than a parser. The verifier side
  /// does the real validation — checksum, alphabet, canonical grouping — in
  /// `protocol/tools/principal.mjs`, because that is where principals arrive as
  /// untrusted text. Here the principal is produced, never parsed.
  public let minPrincipalTextSize : Nat = 8;
  public let maxPrincipalTextSize : Nat = 63;

  public func spec() : Spec {
    {
      version = version;
      algorithm = currentAlgorithm;
      domain = domainV1;
      layout = layoutV1;
      digestSize = digestSize;
      minSaltSize = 16;
      maxSaltSize = 64;
      minPrincipalTextSize = minPrincipalTextSize;
      maxPrincipalTextSize = maxPrincipalTextSize;
    }
  };

  /// `Principal.toText` is already the canonical form the layout wants:
  /// lowercase base32 with dashes, no surrounding whitespace. The Node CLI
  /// reaches the same string by trimming and lowercasing whatever it was
  /// handed, which is a normalization step the canister does not need because
  /// it never receives the principal as text.
  public func canonicalPrincipalText(owner : Principal) : Text {
    Principal.toText(owner)
  };

  public func validPrincipalText(value : Text) : Bool {
    value.size() >= minPrincipalTextSize and value.size() <= maxPrincipalTextSize
  };

  /// Exposed separately from `digest` so the conformance vectors can pin the
  /// bytes that get hashed, not only the hash.
  public func preimage(algorithm : Algorithm, parts : Parts) : Blob {
    switch (algorithm) {
      case (#sha256V1) {
        let separator : Blob = "\00";
        concat([
          Text.encodeUtf8(domainV1),
          separator,
          Text.encodeUtf8(parts.principalText),
          separator,
          parts.manifestHash,
          separator,
          parts.salt
        ])
      }
    }
  };

  public func digest(algorithm : Algorithm, parts : Parts) : Blob {
    switch (algorithm) {
      case (#sha256V1) Sha256.fromBlob(#sha256, preimage(algorithm, parts));
    }
  };

  public func matches(algorithm : Algorithm, expected : Blob, parts : Parts) : Bool {
    Blob.equal(expected, digest(algorithm, parts))
  };

  func concat(parts : [Blob]) : Blob {
    var total : Nat = 0;
    for (part in parts.values()) {
      total += part.size()
    };
    let buffer = VarArray.repeat<Nat8>(0, total);
    var offset : Nat = 0;
    for (part in parts.values()) {
      for (byte in Blob.toArray(part).values()) {
        buffer[offset] := byte;
        offset += 1
      }
    };
    VarArray.toBlob(buffer)
  };
};
