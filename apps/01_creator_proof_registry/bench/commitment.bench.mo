// What the on-chain commitment check costs, in instructions.
//
// Measuring this from the outside does not work: `icp canister call backend
// reveal` burns around 9.2M cycles whichever branch it takes, and the ingress
// message size changes with the salt, so the two things being compared differ
// by more than the hash. Under `mops bench` the runner is the only code in the
// call, so the number is the check itself.
//
// Run with:
//   mops bench --replica pocket-ic
//
// The three columns are the salt sizes the registry accepts. SHA-256 pads to a
// whole number of 64-byte blocks, so a 16-byte salt (79-byte preimage) is two
// blocks and a 64-byte salt (127-byte preimage) is three.

import Bench "mo:bench";
import Nat "mo:core/Nat";
import Commitment "../backend/src/Commitment";

module {
  public func init() : Bench.Bench {
    let bench = Bench.Bench();

    bench.name("v1 commitment verification");
    bench.description("Preimage assembly plus one SHA-256, by salt size");

    bench.rows(["preimage", "digest", "matches"]);
    bench.cols(["16", "40", "64"]);

    let principalText = "ixbwc-ozr3a-z3chv-th5xh-w364p-77r5q-edmjb-guz35-7z33v-cmuyx-hqe";
    let manifestHash : Blob = "\27\3B\E6\98\FF\9D\6D\BD\10\E2\AC\56\3A\BA\E6\0B\14\CD\43\91\52\C1\53\95\3D\22\26\2A\6B\CD\DD\6B";

    let salt16 : Blob = "\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5";
    let salt40 : Blob = "\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5";
    let salt64 : Blob = "\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5\A5";

    func parts(col : Text) : Commitment.Parts {
      let salt = switch (col) {
        case "16" salt16;
        case "40" salt40;
        case _ salt64;
      };
      { principalText; manifestHash; salt }
    };

    bench.runner(
      func(row, col) {
        let input = parts(col);
        switch (row) {
          case "preimage" ignore Commitment.preimage(#sha256V1, input);
          case "digest" ignore Commitment.digest(#sha256V1, input);
          // The real call shape: `reveal` compares against the stored hash, and
          // a mismatch is the branch an attacker drives, so measure that one.
          case _ ignore Commitment.matches(#sha256V1, manifestHash, input);
        }
      }
    );

    bench
  };
};
