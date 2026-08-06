// Minimal reproduction: `Prim.envVar` traps when the variable name is a `Text`
// that was built at run time.
//
// No package dependencies — `mo:⛔` only, so this compiles with a bare `moc`.
//
//   moc -c EnvVarRope.mo -o EnvVarRope.wasm
//   (install on any replica and call each method)
//
// Expected: all three return "unset", because no such variable is set.
// Actual:   `runtimeRope` traps with
//     ic0.env_var_name_exists: Variable name is not a valid UTF-8 string
import Prim "mo:⛔";

persistent actor EnvVarRope {

  // `suffix` is a mutable variable, so `"..." # suffix` cannot be constant
  // folded and stays a rope rather than one contiguous blob.
  var suffix : Text = "llm";

  func lookup<system>(name : Text) : Text {
    switch (Prim.envVar<system>(name)) { case (?value) value; case null "unset" };
  };

  /// A literal. The compiler folds it into a single blob before the call.
  public func literal() : async Text {
    lookup<system>("PUBLIC_CANISTER_ID:llm");
  };

  /// The same name, concatenated at run time. This is the failing case.
  public func runtimeRope() : async Text {
    lookup<system>("PUBLIC_CANISTER_ID:" # suffix);
  };

  /// A rope handed to a different prim that also reads the text's bytes.
  /// This succeeds, which is what narrows the fault to the env-var primitive
  /// rather than to ropes in general.
  public func ropeElsewhere() : async Text {
    let rope = "PUBLIC_CANISTER_ID:" # suffix;
    Prim.debugPrint(rope);
    let bytes = Prim.encodeUtf8(rope);
    "debugPrint and encodeUtf8 both accepted the rope; " # debug_show bytes.size() # " bytes";
  };

  /// The same rope, forced into one contiguous allocation through a `Blob`
  /// round trip first. This is the workaround.
  public func flattened() : async Text {
    let rope = "PUBLIC_CANISTER_ID:" # suffix;
    let flat = switch (Prim.decodeUtf8(Prim.encodeUtf8(rope))) {
      case (?text) text;
      case null "";
    };
    lookup<system>(flat);
  };
};
