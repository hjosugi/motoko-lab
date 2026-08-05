---
title: "Report the Prim.envVar rope trap to the Motoko compiler"
labels: ["priority:P1", "area:compiler", "type:research", "effort:M"]
milestone: "M5 Upstream Maintainer"
---
# Context

`Prim.envVar` traps with `ic0.env_var_name_exists: Variable name is not a valid UTF-8 string` when the variable name is a `Text` built by concatenation at run time. Motoko keeps such a value as a rope rather than one contiguous blob, and the prim appears to hand the system API the unflattened representation.

Found while bringing up `apps/06_distributed_llm` on a replica. It is invisible to `moc -r`, because the interpreter has no `ic0.*` system API, and it traps at install time on a replica when the call sits in an actor initialiser.

Reproduced on `moc` 1.11.1 against `pocket-ic` 14.0.0:

| name expression | result |
|---|---|
| `"PUBLIC_CANISTER_ID:llm"` (literal) | works |
| `"PUBLIC_CANISTER_ID:" # suffix` where `suffix` is a variable | traps |
| the same rope, flattened through `decodeUtf8(encodeUtf8(...))` first | works |

A literal survives because the compiler folds it into one blob before the call, including a literal passed through a helper function. `mo:llm` never hits this because its name is a constant. Anything that derives the name from a variable does.

`apps/06_distributed_llm/backend/src/Env.mo` works around it and pins the behaviour in `test/Env.test.mo`.

## Scope

- [ ] Reduce to a minimal canister that traps, without this kit's dependencies.
- [ ] Confirm against the current `moc` release, not only the pinned 1.11.1.
- [ ] Determine whether the fix belongs in the prim (flatten the argument) or in the RTS text representation handed to `ic0.env_var_name_exists`.
- [ ] File upstream with the reproduction and the version matrix.
- [ ] Link the upstream issue from `Env.mo` and remove the workaround when it lands.

## Acceptance criteria

- [ ] Upstream issue exists and references a runnable reproduction.
- [ ] The behaviour matrix in `Env.mo` matches what upstream reproduces.
- [ ] `test/Env.test.mo` still pins the flattening contract whether or not the workaround is removed.

## Test plan

- [ ] Minimal canister installed on `pocket-ic`, name from a literal and from a variable
- [ ] Same canister on a local `icp` network
- [ ] Re-run `apps/06_distributed_llm` end to end with the workaround removed once fixed

## Dependencies

#001

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
