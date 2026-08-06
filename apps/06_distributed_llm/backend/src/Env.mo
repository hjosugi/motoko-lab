/// Canister environment variables.
///
/// `icp deploy` injects the principal of every canister in the project as
/// `PUBLIC_CANISTER_ID:<name>`, which is how `mo:llm` finds a locally deployed
/// `llm` canister without anyone editing a source file. The orchestrator uses
/// the same mechanism to discover its workers, so a fresh `icp deploy` produces
/// a wired cluster with no principals copied by hand.
///
/// Reading an environment variable needs the `system` capability, which exists
/// in an actor's initialiser and in the body of a `shared` function, but not in
/// a `query`. Callers therefore have to thread `<system>` through.
///
/// ## The rope trap
///
/// `Prim.envVar` traps with
///
///     ic0.env_var_name_exists: Variable name is not a valid UTF-8 string
///
/// when the name is a `Text` built by concatenation at run time. Motoko keeps
/// such a value as a rope rather than one contiguous blob, and the prim hands
/// the system API the unflattened representation.
///
/// Reproduced identically on moc 1.11.1 and on moc 1.13.0 (the current release,
/// 2026-08-03) against pocket-ic 14.0.0. A standalone reproduction, including
/// the case that narrows the fault to this primitive rather than to ropes in
/// general, is in `compiler/repros/envvar-rope/`.
///
/// Behaviour matrix:
///
/// | name expression                          | result |
/// |------------------------------------------|--------|
/// | `"PUBLIC_CANISTER_ID:llm"` (literal)      | works  |
/// | `"PUBLIC_CANISTER_ID:" # suffix` (rope)   | traps  |
/// | the same rope, flattened first            | works  |
///
/// A literal survives because the compiler folds it into one blob before the
/// call - including a literal passed through a helper function - which is why
/// `mo:llm`, whose name is a constant, never hits this. Anything that builds
/// the name from a variable does.
///
/// `flatten` below forces the rope into a contiguous text through a `Blob`
/// round trip. Remove it once the prim flattens its own argument; the tests in
/// `test/Env.test.mo` pin the behaviour either way.
import Prim "mo:⛔";

module {

  /// Forces a `Text` into a single contiguous allocation.
  ///
  /// `encodeUtf8` materialises the rope into a `Blob`, and `decodeUtf8` reads
  /// it back as a flat `Text`. Every `Text` in Motoko is valid UTF-8 by
  /// construction, so the decode cannot fail; the `null` branch is unreachable
  /// and returns the input rather than trapping.
  public func flatten(text : Text) : Text {
    switch (Prim.decodeUtf8(Prim.encodeUtf8(text))) {
      case (?flat) flat;
      case null text;
    };
  };

  public func get<system>(name : Text) : ?Text {
    Prim.envVar<system>(flatten(name));
  };

  /// Principal of another canister in this project, by its manifest name.
  public func canisterId<system>(name : Text) : ?Text {
    get<system>("PUBLIC_CANISTER_ID:" # name);
  };
};
