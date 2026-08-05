import Env "../backend/src/Env";

// `flatten` must be the identity on the *value* of a text, whatever its
// internal representation. What it changes is that representation: a rope built
// by concatenation becomes one contiguous allocation, which is what
// `Prim.envVar` requires.
assert Env.flatten("") == "";
assert Env.flatten("PUBLIC_CANISTER_ID:llm") == "PUBLIC_CANISTER_ID:llm";

var suffix = "llm";
suffix #= "";
let rope = "PUBLIC_CANISTER_ID:" # suffix;
assert Env.flatten(rope) == rope;
assert Env.flatten(rope) == "PUBLIC_CANISTER_ID:llm";
assert Env.flatten(Env.flatten(rope)) == rope;

// Non-ASCII survives the Blob round trip; the decode branch is not a lossy
// fallback.
assert Env.flatten("キャニスター" # "ID") == "キャニスターID";
assert Env.flatten("a" # "\u{1F600}" # "b") == "a\u{1F600}b";

// The trap this exists to avoid only happens on a replica: `moc -r` has no
// `ic0.env_var_name_exists`, so `Prim.envVar` cannot be exercised here.
// `tools/pocket-ic-e2e.mjs` covers it - installing the orchestrator, whose
// initialiser resolves `PUBLIC_CANISTER_ID:llm` through `Env.canisterId`, fails
// outright if `flatten` is removed.
