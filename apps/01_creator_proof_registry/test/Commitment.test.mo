// Conformance tests for the v1 commitment.
//
// Four separate claims, because they can fail independently:
//
//   1. `mo:sha2` computes SHA-256, checked against the FIPS 180-4 examples.
//   2. `Commitment.preimage` lays the fields out in the documented order,
//      checked byte for byte rather than only through the digest.
//   3. Each of the three bound fields, changed on its own, breaks the match.
//   4. The digest agrees with the frozen conformance vectors in
//      `protocol/test-vectors/commitment/vectors.json`, which two
//      implementations sharing no code with this one — one Rust, one
//      TypeScript — also reproduce.
//
// Every expected value here came from `protocol/tools/commitment.mjs`; see
// docs/COMMITMENT_V1.md and protocol/COMMITMENT_V1.md.

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
// The bounds are the full range of the principal textual form: 8 characters for
// the empty blob, 63 for the 29-byte maximum.
assert Commitment.validPrincipalText("aaaaa-aa");
assert Commitment.validPrincipalText("rrkah-fqaaa-aaaaa-aaaaq-cai");
assert Commitment.validPrincipalText("ixbwc-ozr3a-z3chv-th5xh-w364p-77r5q-edmjb-guz35-7z33v-cmuyx-hqe");
assert not Commitment.validPrincipalText("aaaa");
assert not Commitment.validPrincipalText("");
assert "aaaaa-aa".size() == Commitment.minPrincipalTextSize;
assert "ixbwc-ozr3a-z3chv-th5xh-w364p-77r5q-edmjb-guz35-7z33v-cmuyx-hqe".size() == Commitment.maxPrincipalTextSize;

let overlong = Text.join(Array.repeat<Text>("a", Commitment.maxPrincipalTextSize + 1).values(), "");
assert not Commitment.validPrincipalText(overlong);

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

// 6. The frozen v1 conformance vectors, from
// protocol/test-vectors/commitment/vectors.json. Those vectors are also run
// against two implementations that share no code with this one — one Rust, one
// TypeScript — by protocol/tools/crosscheck.mjs. Agreeing with them is what
// makes the canister and an off-chain verifier interchangeable.
//
// The vectors that exist to pin *parsing* behaviour (uppercase hexadecimal,
// surrounding whitespace) are not repeated here: this side receives bytes and a
// principal it produced itself, and never parses either.

// principal-empty-blob: the management canister, the shortest principal text there is
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\95\B0\A5\D9\0F\DD\EB\ED\D7\94\8D\E0\8B\9F\D3\26\B6\B5\4C\BF\B5\E3\DE\69\A4\F4\29\D5\6F\63\FE\56";

// principal-anonymous: the anonymous principal, a one-byte blob
assert Commitment.digest(#sha256V1, {
  principalText = "2vxsx-fae";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\62\21\27\37\41\70\DD\99\B7\E0\F1\3E\97\86\EA\61\3D\57\5D\2A\94\A7\96\26\32\BB\13\A2\3C\1F\38\15";

// principal-canister: an opaque canister principal
assert Commitment.digest(#sha256V1, {
  principalText = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\34\36\35\98\DC\A2\8E\71\A0\99\DD\76\C9\91\39\26\19\1B\84\0E\6A\1D\EA\BB\59\AD\69\7A\70\1D\6D\C7";

// principal-canister-mainnet-llm: another canister principal, ten bytes
assert Commitment.digest(#sha256V1, {
  principalText = "w36hm-eqaaa-aaaal-qr76a-cai";
  manifestHash = "\31\17\9F\0B\46\50\BC\FF\35\DE\13\E4\57\6A\43\0C\28\6B\09\9A\6B\7B\3C\4E\87\41\52\8E\D6\B7\08\3F";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\90\BF\8D\F8\4D\B9\FD\28\E0\80\6E\2C\95\68\AA\AD\20\24\71\95\6F\E2\20\33\09\CE\50\D5\31\34\5C\A6";

// principal-self-authenticating: a 29-byte blob, the longest principal text there is
assert Commitment.digest(#sha256V1, {
  principalText = "ixbwc-ozr3a-z3chv-th5xh-w364p-77r5q-edmjb-guz35-7z33v-cmuyx-hqe";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\AE\4A\CD\6F\D4\D9\0B\0D\B4\30\E8\39\BC\C2\F7\14\C5\CE\BE\1A\BC\89\C8\DC\31\3C\F6\BD\7D\81\D1\8E";

// salt-minimum: a salt at the 16-byte lower bound
assert Commitment.digest(#sha256V1, {
  principalText = "ixbwc-ozr3a-z3chv-th5xh-w364p-77r5q-edmjb-guz35-7z33v-cmuyx-hqe";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F\0F";
}) == "\40\32\30\18\33\A6\20\21\D2\C6\21\95\97\A5\D2\21\E9\1A\39\97\D3\3C\E1\9B\50\4E\7C\C1\92\35\E7\B6";

// salt-maximum: a salt at the 64-byte upper bound
assert Commitment.digest(#sha256V1, {
  principalText = "ixbwc-ozr3a-z3chv-th5xh-w364p-77r5q-edmjb-guz35-7z33v-cmuyx-hqe";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5";
}) == "\F6\6E\B3\30\68\30\7C\26\FC\2A\53\1E\99\08\9C\DB\F9\EA\55\A8\F9\0F\B5\A3\43\07\D7\D8\40\49\EE\9B";

// salt-all-zero: a salt that is entirely separator bytes; it is the last field, so it cannot be mistaken for one
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";
}) == "\74\5F\5F\B7\A2\19\A1\87\56\CF\A0\88\C5\FE\3C\27\41\34\FD\D9\26\34\BD\16\BE\2C\72\B8\1E\2F\7A\E9";

// salt-leading-zero: a salt beginning with a separator byte
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\00\11\11\11\11\11\11\11\11\11\11\11\11\11\11\11";
}) == "\46\3B\F6\77\7D\6D\87\24\E0\06\86\40\CF\6C\52\1C\6B\FB\99\CF\0E\AD\6C\7D\E5\2E\1E\C1\12\DB\D6\45";

// salt-all-ff: a salt with no zero bytes at all
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF";
}) == "\D2\49\4E\11\80\59\69\CC\1D\F9\C5\69\27\7A\D4\0A\99\D3\4F\D1\54\B8\A1\F9\B6\44\54\26\EA\EF\C0\AB";

// digest-all-zero: a manifest digest of 32 separator bytes, read positionally and never scanned
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\E4\B1\D0\A9\96\58\B5\BD\39\F1\77\D3\16\62\93\81\D3\28\89\45\D8\BF\F6\2F\C2\3E\A1\5C\E7\35\EB\D8";

// digest-all-ff: a manifest digest with no zero bytes
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF\FF";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\4C\88\DF\8F\AA\47\29\CC\01\E3\35\C2\7D\AC\89\84\8F\4F\13\F2\19\92\DC\1A\59\F8\11\D5\02\6E\75\CE";

// published-human-only: the human-only example manifest from protocol/examples
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\31\17\9F\0B\46\50\BC\FF\35\DE\13\E4\57\6A\43\0C\28\6B\09\9A\6B\7B\3C\4E\87\41\52\8E\D6\B7\08\3F";
  salt = "\00\11\22\33\44\55\66\77\88\99\AA\BB\CC\DD\EE\FF";
}) == "\DA\A3\33\41\A4\20\EA\F9\EF\8B\08\87\D1\B4\59\19\7D\0A\FB\70\AB\30\5E\1C\58\F4\5B\0B\58\51\51\4A";

// published-ai-assisted: the AI-assisted example manifest from protocol/examples
assert Commitment.digest(#sha256V1, {
  principalText = "aaaaa-aa";
  manifestHash = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";
  salt = "\FF\EE\DD\CC\BB\AA\99\88\77\66\55\44\33\22\11\00";
}) == "\66\A2\BE\F9\64\72\B8\69\96\55\A1\6D\43\DD\8D\91\08\78\F1\6D\08\18\F8\91\01\0C\DA\E6\02\07\A5\56";

// 5. The advertised spec is the one the code actually implements, so a client
// that reads `commitmentSpec` and rebuilds the preimage from it agrees.
// It also has to match `spec()` in protocol/tools/commitment.mjs field for
// field, because that is the record the frozen vectors were generated against.
let spec = Commitment.spec();
assert spec.version == "v1";
assert spec.algorithm == #sha256V1;
assert spec.domain == Commitment.domainV1;
assert spec.layout == "domain-zero-principalText-zero-manifestDigest-zero-salt";
assert spec.digestSize == 32;
assert spec.minSaltSize == minSalt.salt.size();
assert spec.maxSaltSize == maxSalt.salt.size();
assert spec.minPrincipalTextSize == 8;
assert spec.maxPrincipalTextSize == 63;
assert Text.encodeUtf8(spec.domain).size() == 20;
assert Blob.equal(Commitment.digest(spec.algorithm, humanOnly), humanOnlyCommitment);
