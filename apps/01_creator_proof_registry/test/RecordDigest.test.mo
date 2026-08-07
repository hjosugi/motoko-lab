// The record encoding that certified queries attest.
//
// The replica suite already compares this implementation against the
// JavaScript one on every record it certifies, which is the check that
// matters. This pins the bytes in the interpreter so a change to the layout
// fails in `mops test` — in seconds, naming the layout — rather than several
// minutes later inside a certificate comparison, where the symptom is only
// "the digest did not match".
//
// The expected values were produced by `test/record-digest.mjs`.

import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import RecordDigest "../backend/src/RecordDigest";

// Every optional shape is exercised at once: a variant payload (`#other`), a
// present optional, an absent optional, a present digest, and a revoked status.
// The empty cases are covered separately below.
let full : RecordDigest.Record = {
  id = 7;
  commitmentId = 3;
  owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
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

// Byte for byte, so a change to a length prefix, a tag, or the field order
// fails here and not as an opaque digest mismatch.
assert RecordDigest.encode(full) == "\69\63\70\2D\63\72\65\61\74\6F\72\2D\70\72\6F\6F\66\3A\72\65\63\6F\72\64\3A\76\31\00\00\00\00\00\00\00\00\07\00\00\00\00\00\00\00\03\0A\00\00\00\00\00\00\00\01\01\01\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\10\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\00\00\00\01\74\00\00\00\05\69\6D\61\67\65\00\00\00\09\69\6D\61\67\65\2F\70\6E\67\00\00\00\08\69\70\66\73\3A\2F\2F\78\00\00\00\02\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\02\01\04\00\00\00\06\E7\A0\94\E7\A9\B6\01\00\00\00\04\61\63\6D\65\00\01\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\DD\00\00\00\00\00\49\96\02\D2\01\00\00\00\00\00\00\03\E7\00\00\00\0A\73\75\70\65\72\73\65\64\65\64";
assert RecordDigest.encode(full).size() == 282;
assert RecordDigest.digest(full) == "\7C\EB\FD\29\98\6D\64\D7\E9\AA\AF\F3\25\AB\B5\7C\0F\5F\E0\86\07\C9\90\22\84\54\9A\95\83\DF\D8\F8";

// The domain is versioned, like the commitment's, so a v1 encoding can never be
// reinterpreted under v2 rules.
assert Text.encodeUtf8(RecordDigest.domainV1) == "\69\63\70\2D\63\72\65\61\74\6F\72\2D\70\72\6F\6F\66\3A\72\65\63\6F\72\64\3A\76\31";
assert RecordDigest.version == "v1";

// Each field, changed on its own, has to change the digest. This is what makes
// a certified query detect an alteration rather than only an absence.
let baseline = RecordDigest.digest(full);
assert RecordDigest.digest({ full with storageUri = "ipfs://elsewhere" }) != baseline;
assert RecordDigest.digest({ full with title = "u" }) != baseline;
assert RecordDigest.digest({ full with id = 8 }) != baseline;
assert RecordDigest.digest({ full with commitmentId = 4 }) != baseline;
assert RecordDigest.digest({ full with owner = Principal.fromText("aaaaa-aa") }) != baseline;
assert RecordDigest.digest({ full with parents = [2, 1] }) != baseline;
assert RecordDigest.digest({ full with createdAt = 1234567891 }) != baseline;
assert RecordDigest.digest({ full with status = #active }) != baseline;
assert RecordDigest.digest({ full with status = #revoked({ at = 999; reason = "other" }) }) != baseline;
assert RecordDigest.digest({ full with ai = { full.ai with assisted = false } }) != baseline;
assert RecordDigest.digest({ full with ai = { full.ai with mode = #assist } }) != baseline;

// A present-but-empty optional and an absent one must not encode alike. Without
// the present-flag they would, and a record could be presented with a provider
// it never declared.
let absent : RecordDigest.Record = { full with ai = { full.ai with provider = null } };
let empty : RecordDigest.Record = { full with ai = { full.ai with provider = ?"" } };
assert RecordDigest.digest(absent) != RecordDigest.digest(empty);

// Neither may a moved boundary between two adjacent variable-length fields.
assert RecordDigest.digest({ full with title = "ab"; kind = "c" }) != RecordDigest.digest({ full with title = "a"; kind = "bc" });

// The tree key is the id as eight big-endian bytes, so byte-wise label order
// matches numeric order.
assert RecordDigest.idKey(0) == "\00\00\00\00\00\00\00\00";
assert RecordDigest.idKey(1) == "\00\00\00\00\00\00\00\01";
assert RecordDigest.idKey(258) == "\00\00\00\00\00\00\01\02";
assert Blob.compare(RecordDigest.idKey(2), RecordDigest.idKey(10)) == #less;
assert RecordDigest.treeLabel == "record";
