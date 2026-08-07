// What certifying a record costs, in instructions.
//
// Certification is paid on every `reveal` and every `revokeRecord`, so the
// question is what those update calls got more expensive by. Two costs, and
// they scale differently:
//
//   * `digest` — encoding the record and hashing it. Grows with the record, not
//     with the registry.
//   * `put` — inserting into the hash tree and rehashing the path to the root.
//     Grows with how deep the new key sits, which for a radix trie is set by
//     where it diverges from the keys already there, not by the record count.
//
// The columns are registry sizes and the inserted id is always the next one, so
// what is measured is the insertion the registry actually performs: `reveal`
// assigns sequential ids, so a new key always shares a long prefix with its
// neighbours and sits about as deep as the tree is.
//
//   mops bench --replica pocket-ic

import Bench "mo:bench";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import CertTree "mo:ic-certification/CertTree";
import RecordDigest "../backend/src/RecordDigest";

module {
  public func init() : Bench.Bench {
    let bench = Bench.Bench();

    bench.name("record certification");
    bench.description("Digesting a record and inserting it into the certified tree");

    bench.rows(["digest", "put", "digest+put"]);
    bench.cols(["10", "1000", "10000"]);

    let record : RecordDigest.Record = {
      id = 1;
      commitmentId = 1;
      owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
      artifactHash = "\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA\AA";
      manifestHash = "\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB\BB";
      salt = "\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC\CC";
      title = "a representative title";
      kind = "image";
      mimeType = "image/png";
      storageUri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
      parents = [];
      ai = {
        assisted = true;
        mode = #assist;
        provider = ?"acme";
        model = ?"m-1";
        promptHash = null;
        humanContribution = ?"wording and revision decisions";
      };
      createdAt = 1786022004489337594;
      status = #active;
    };

    // One prepopulated tree per column, built outside the measured runner.
    func treeOf(size : Nat) : CertTree.Ops {
      let store = CertTree.newStore();
      let ops = CertTree.Ops(store);
      for (id in Nat.range(0, size)) {
        ops.put([RecordDigest.treeLabel, RecordDigest.idKey(id)], RecordDigest.digest({ record with id }))
      };
      ops
    };

    let small = treeOf(10);
    let medium = treeOf(1000);
    let large = treeOf(10000);

    // The next sequential id for each column, which is the key `reveal` would
    // insert. A far-away id would diverge from the existing keys in the first
    // byte and measure a much shallower insert than the registry ever does.
    func nextId(col : Text) : Nat {
      switch (col) {
        case "10" 10;
        case "1000" 1000;
        case _ 10000
      }
    };

    bench.runner(
      func(row, col) {
        let tree = switch (col) {
          case "10" small;
          case "1000" medium;
          case _ large;
        };
        let id = nextId(col);
        let subject = { record with id };
        switch (row) {
          case "digest" ignore RecordDigest.digest(subject);
          case "put" tree.put([RecordDigest.treeLabel, RecordDigest.idKey(id)], record.artifactHash);
          case _ tree.put([RecordDigest.treeLabel, RecordDigest.idKey(id)], RecordDigest.digest(subject))
        }
      }
    );

    bench
  };
};
