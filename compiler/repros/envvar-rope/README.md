# `Prim.envVar` traps on a runtime-constructed name

Minimal reproduction for the bug found while bringing `apps/06_distributed_llm`
up on a replica. Tracked as issue #42.

## Summary

`Prim.envVar` traps with

```
ic0.env_var_name_exists: Variable name is not a valid UTF-8 string
```

when the variable name is a `Text` built by concatenation at run time. Motoko
represents such a value as a rope rather than one contiguous blob, and the
env-var primitive appears to hand the system API the unflattened representation.

A name that is a literal survives, because the compiler folds it into a single
blob before the call — including a literal passed through a helper function.
That is why `mo:llm`, whose variable name is a constant, never hits this, and
why anything that derives the name from a variable does.

## Confirmed on

| compiler | result |
|---|---|
| `moc` 1.11.1 | traps |
| `moc` 1.13.0 (current release, 2026-08-03) | traps |

Both against `pocket-ic` 14.0.0. Nothing in the 1.11.2, 1.12.0 or 1.13.0
changelog entries touches the env-var primitives, which matches.

## Reproduce

```bash
moc -c EnvVarRope.mo -o EnvVarRope.wasm
# install on any replica, then call each method
```

`EnvVarRope.mo` has no package dependencies — `mo:⛔` only — so a bare `moc` is
enough. `apps/06_distributed_llm/tools/pocket-ic-setup.mjs` will fetch a replica
and Candid tooling if you need them.

## Observed

Identical on both compiler versions:

```
literal        -> unset
runtimeRope    -> TRAP: ic0.env_var_name_exists: Variable name is not a valid UTF-8 string
ropeElsewhere  -> debugPrint and encodeUtf8 both accepted the rope; 22 bytes
flattened      -> unset
```

Reading the four cases:

- `literal` — the name is a constant, folded to one blob. Works.
- `runtimeRope` — the same 22 bytes, concatenated from a variable. Traps.
- `ropeElsewhere` — hands the *same rope* to `debugPrint` and `encodeUtf8`,
  which both read the text's bytes and both accept it. This is what narrows the
  fault to the env-var primitive rather than to ropes in general, and it is the
  case worth keeping in any upstream report.
- `flattened` — the same rope forced through a `Blob` round trip first. Works,
  and is the workaround `apps/06_distributed_llm/backend/src/Env.mo` uses.

## Why it is easy to miss

The interpreter has no `ic0.*` system API, so `moc -r` cannot reach this at all.
On a replica it surfaces at *install* time whenever the call sits in an actor
initialiser, which reads as "my canister will not install" rather than as a
string-representation bug.

## Next steps

Decide whether the fix belongs in the primitive (flatten its argument, as
`encodeUtf8` effectively does) or in what the RTS passes to
`ic0.env_var_name_exists`, then file upstream with this reproduction. The
workaround in `Env.mo` can be removed once it lands; `test/Env.test.mo` pins the
flattening contract either way.
