// Conformance tests for the v1 commitment.
//
// Three separate claims, because they can fail independently:
//
//   1. `mo:sha2` computes SHA-256, checked against the FIPS 180-4 examples.
//   2. `Commitment.preimage` lays the fields out in the documented order,
//      checked byte for byte rather than only through the digest.
//   3. The digest agrees with `protocol/tools/provenance-cli.mjs`, checked
//      against the vectors in `protocol/test-vectors/test-vectors.json` plus
//      both salt-size boundaries.
//
// Every expected value here was produced by Node's `crypto` and cross-checked
// against the CLI's own `commitmentHex`; see docs/COMMITMENT_V1.md.

import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import Commitment "../backend/src/Commitment";

func sha256(message : Text) : Blob {
  Sha256.fromBlob(#sha256, Text.encodeUtf8(message))
};

// 1. FIPS 180-4 SHA-256 examples.
//
// The one-million-`a` example is left out on purpose: it says nothing the
// two-block example does not, and it makes `mops test` take minutes under the
// interpreter. Multi-block behaviour is covered by the 896-bit case, which is
// 112 bytes and therefore spans two compression blocks after padding.
assert sha256("") == "\E3\B0\C4\42\98\FC\1C\14\9A\FB\F4\C8\99\6F\B9\24\27\AE\41\E4\64\9B\93\4C\A4\95\99\1B\78\52\B8\55";
assert sha256("abc") == "\BA\78\16\BF\8F\01\CF\EA\41\41\40\DE\5D\AE\22\23\B0\03\61\A3\96\17\7A\9C\B4\10\FF\61\F2\00\15\AD";
assert sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") == "\24\8D\6A\61\D2\06\38\B8\E5\C0\26\93\0C\3E\60\39\A3\3C\E4\59\64\FF\21\67\F6\EC\ED\D4\19\DB\06\C1";
assert sha256("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu") == "\CF\5B\16\A7\78\AF\83\80\03\6C\E5\9E\7B\04\92\37\0B\24\9B\11\E8\F0\7A\51\AF\AC\45\03\7A\FE\E9\D1";

// 2. The management canister principal is the one the published vectors use,
// and `toText` has to reproduce it exactly or the digests cannot match.
let managementCanister = Principal.fromText("aaaaa-aa");
assert Commitment.canonicalPrincipalText(managementCanister) == "aaaaa-aa";
assert Commitment.validPrincipalText("aaaaa-aa");
assert Commitment.validPrincipalText("rrkah-fqaaa-aaaaa-aaaaq-cai");
assert not Commitment.validPrincipalText("aaaa");
assert not Commitment.validPrincipalText("");

let hundred = Text.join(Array.repeat<Text>("a", 100).values(), "");
assert hundred.size() == 100;
assert Commitment.validPrincipalText(hundred);
assert not Commitment.validPrincipalText(hundred # "a");

let humanOnly : Commitment.Parts = {
  principalText = "aaaaa-aa";
  manifestHash = "\31\17\9F\0B\46\50\BC\FF\35\DE\13\E4\57\6A\43\0C\28\6B\09\9A\6B\7B\3C\4E\87\41\52\8E\D6\B7\08\3F";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
};

// Byte-for-byte, so a change to the separator, the domain string or the field
// order fails here and not only as an opaque digest mismatch.
assert Commitment.preimage(#sha256V1, humanOnly) == "\69\63\70\2D\63\72\65\61\74\6F\72\2D\70\72\6F\6F\66\3A\76\31\00\61\61\61\61\61\2D\61\61\00\31\17\9F\0B\46\50\BC\FF\35\DE\13\E4\57\6A\43\0C\28\6B\09\9A\6B\7B\3C\4E\87\41\52\8E\D6\B7\08\3F\00\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
assert Commitment.preimage(#sha256V1, humanOnly).size() == 20 + 1 + 8 + 1 + 32 + 1 + 16;

// 3. Cross-language vectors. The first two are the published
// `protocol/test-vectors/test-vectors.json` entries; the last two pin the
// 16-byte and 64-byte salt boundaries that `Validation.validSalt` allows.
let humanOnlyCommitment : Blob = "\DA\A3\33\41\A4\20\EA\F9\EF\8B\08\87\D1\B4\59\19\7D\0A\FB\70\AB\30\5E\1C\58\F4\5B\0B\58\51\51\4A";
assert Commitment.digest(#sha256V1, humanOnly) == humanOnlyCommitment;
assert Commitment.matches(#sha256V1, humanOnlyCommitment, humanOnly);

let aiAssisted : Commitment.Parts = {
  principalText = "aaaaa-aa";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\FF\EE\DD\CC\BB\AA\99\88\77\66\55\44\33\22\11\00";
};
assert Commitment.digest(#sha256V1, aiAssisted) == "\66\A2\BE\F9\64\72\B8\69\96\55\A1\6D\43\DD\8D\91\08\78\F1\6D\08\18\F8\91\01\0C\DA\E6\02\07\A5\56";

let minSalt : Commitment.Parts = {
  principalText = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  manifestHash = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";
  salt = "\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F";
};
assert minSalt.salt.size() == 16;
assert Commitment.digest(#sha256V1, minSalt) == "\A6\45\7B\07\DE\95\A8\24\1D\F2\2A\8E\01\67\1C\E4\0B\E2\F9\27\31\69\52\4B\D5\7B\0D\57\91\F6\13\C3";

// An all-`0x00` manifest hash next to a 0x00 separator is the case a
// length-prefix-free layout would get wrong, so it is worth having.
assert Commitment.preimage(#sha256V1, minSalt).size() == 20 + 1 + 27 + 1 + 32 + 1 + 16;

let maxSalt : Commitment.Parts = {
  principalText = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  manifestHash = "\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF";
  salt = "\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5";
};
assert maxSalt.salt.size() == 64;
assert Commitment.digest(#sha256V1, maxSalt) == "\6A\59\05\C6\57\73\7B\D8\C1\72\59\81\41\C5\FC\DC\2D\57\EE\6E\13\A0\B4\8B\25\0D\D5\D7\93\69\7A\C4";

// 4. Each of the three bound fields, changed on its own, must break the match.
// This is what `reveal` relies on to reject a caller who commits to one thing
// and reveals another.
assert not Commitment.matches(
  #sha256V1,
  humanOnlyCommitment,
  { humanOnly with principalText = "rrkah-fqaaa-aaaaa-aaaaq-cai" }
);
assert not Commitment.matches(
  #sha256V1,
  humanOnlyCommitment,
  { humanOnly with manifestHash = aiAssisted.manifestHash }
);
assert not Commitment.matches(
  #sha256V1,
  humanOnlyCommitment,
  { humanOnly with salt = aiAssisted.salt }
);

// Flipping a single bit of the salt is enough.
assert not Commitment.matches(
  #sha256V1,
  humanOnlyCommitment,
  { humanOnly with salt = "\01\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF" }
);

// 5. The advertised spec is the one the code actually implements, so a client
// that reads `commitmentSpec` and rebuilds the preimage from it agrees.
let spec = Commitment.spec();
assert spec.algorithm == #sha256V1;
assert spec.domain == Commitment.domainV1;
assert spec.digestSize == 32;
assert spec.minSaltSize == minSalt.salt.size();
assert spec.maxSaltSize == maxSalt.salt.size();
assert Text.encodeUtf8(spec.domain).size() == 20;
assert Blob.equal(Commitment.digest(spec.algorithm, humanOnly), humanOnlyCommitment);
