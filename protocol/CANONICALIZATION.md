# Canonicalization

Issue #4. The manifest digest is what the on-chain commitment binds, so two
verifiers that disagree about the canonical bytes disagree about whether a
record is valid. The CLI used to sort object keys recursively and hand the
result to `JSON.stringify`, and called itself "a deterministic educational
subset" — accurate, and not something to build a provenance claim on.

It now implements RFC 8785 (JSON Canonicalization Scheme).

## What was actually missing

Not the serialization. RFC 8785 defines three of its rules by pointing at
ECMAScript, and the old code got all three right for free:

| Rule | RFC 8785 | ECMAScript |
| --- | --- | --- |
| Numbers | §3.2.2.3 | `Number::toString`, which is what `JSON.stringify` emits |
| Strings | §3.2.2.2 | `JSON.stringify` escaping: `"`, `\`, and the C0 controls, nothing else |
| Member order | §3.2.3 | sort by UTF-16 code unit, which is JavaScript's default string comparison |

What was missing is everything `JSON.parse` discards before you can look at it,
which is why `tools/jcs.mjs` scans the text itself rather than calling
`JSON.parse`:

- **Duplicate member names.** `JSON.parse` silently keeps the last occurrence,
  so `{"a":1,"a":2}` and `{"a":2}` produce the same digest. A manifest can carry
  a claim that no verifier will ever hash. `serde_jcs` has the same behaviour —
  it returns `{"a":2}` without a word.
- **Lone surrogates.** `"\ud800"` survives `JSON.parse` and round-trips through
  `JSON.stringify` as an escape. Implementations built on UTF-8 strings reject
  the input outright, so the same document is valid here and invalid there.
- **Numbers outside the double range.** `1E400` parses to `Infinity`, which
  RFC 8785 has no serialization for.

## Two deliberate deviations

Both are refusals. Neither changes the bytes produced for an input that is
accepted, so a document this tool canonicalizes is canonicalized identically by
any conformant implementation.

**Duplicate member names are rejected, not resolved.** RFC 8785 inherits
ECMAScript's last-wins rule. For a signed provenance manifest, silently
discarding a member the creator wrote is the wrong default.

**An integer literal that does not round-trip exactly is rejected.** JCS is
defined over the parsed double, so `12345678901234567890` is legally serialized
as `12345678901234567000` — and the official `values` vector *requires* that
behaviour for `333333333.33333329`. Fine for a number that was always
approximate. Not fine for a bare integer literal, where every digit was written
to be exact and the manifest carries file sizes, identifiers and timestamps.
`serde_jcs` rounds it the same way, so this is not an interop disagreement:
both implementations lose the same digits, quietly.

The test is exact round-tripping, not digit count. An earlier version of this
check rejected any integer literal above `Number.MAX_SAFE_INTEGER`, which
rejected `100000000000000000000` — the canonical form of `1e20`, and therefore
its own output. A canonicalization with no fixed point is one that two verifiers
can disagree about by applying it a different number of times, so
`provenance-cli.test.mjs` now asserts idempotency on every vector.

A number written in exponent form is always accepted: it was never claiming
digit-level precision, and the official vectors require `1E30`.

## Motoko's responsibility: none

**The canister never canonicalizes.** It takes a 32-byte manifest digest as an
opaque value and stores it; `Commitment.mo` hashes the digest, not the manifest.
There is no Motoko JSON parser in this kit and there should not be one.

This is a deliberate split, not an omission:

- Canonicalization is only interesting where the JSON *is*. The creator has the
  manifest; the canister has 32 bytes. Sending a manifest on-chain to re-derive
  a digest the caller already computed costs cycles and adds a second
  implementation to keep in step with the first.
- The commitment already binds the digest. A caller who canonicalizes wrongly
  computes a digest that does not match what any verifier recomputes, and the
  record is refutable by anyone. Nothing is gained by having the canister catch
  it earlier, and a canister-side parser would be a new place for the two
  implementations to disagree.
- The verifier is where the check belongs, because the verifier is the party
  that does not trust the creator.

`apps/01_creator_proof_registry` enforces `digest.size() == 32` and nothing
about how the digest was produced. See `apps/01_creator_proof_registry/docs/COMMITMENT_V1.md`.

## Versioning

Manifests may carry `"canonicalization": "RFC8785"`. An absent field means
RFC8785, which is the only scheme this protocol has ever specified. A future
scheme must name itself rather than change what an absent field means.

Bundles written by `provenance-cli bundle` always carry the field, because a
bundle is what a verifier reads and it should not have to infer the rule.

The two published example manifests do not carry it, and are unchanged. The old
recursive-key-sort implementation produced byte-identical output for both — which
is exactly why the subset survived as long as it did — so their digests, and the
commitment vectors derived from them, are the same under both schemes.

## Conformance

`node protocol/tools/provenance-cli.test.mjs` — 87 assertions, offline, part of
`scripts/run_offline_checks.sh`:

- The six official vectors from
  [cyberphone/json-canonicalization](https://github.com/cyberphone/json-canonicalization),
  vendored under `test-vectors/jcs/`, compared to the reference output byte for
  byte, and each reference output re-canonicalized to itself.
- 21 accepted edge vectors and 26 rejected ones in `test-vectors/jcs/edge-cases.json`,
  covering minus zero, the exponent-notation thresholds at 1e21 and 1e-7, the
  smallest denormal and largest finite double, every escape form, characters
  that must *not* be escaped (solidus, U+007F, U+0080, U+2028), astral
  characters, UTF-16 code unit ordering, and each rejection above.
- Each rejected vector is pinned to its exact error message, so failure
  behaviour is part of the contract rather than an implementation detail.

## Cross-implementation evidence

`node protocol/tools/crosscheck.mjs` builds a throwaway `serde_jcs` project and
installs the `canonicalize` npm package, then runs all three implementations
over the same inputs. It needs `cargo`, `npm` and network access, so it is
deliberately outside `run_offline_checks.sh` and outside CI.

Last run, 2026-08-07, on `serde_jcs` 0.2.0 / `serde_json` 1.0.151 /
`canonicalize` 3.0.0:

```
29 inputs canonicalized identically by all three implementations
26 rejected inputs, of which serde_jcs also rejects 21
  stricter than serde_jcs: duplicate-key
  stricter than serde_jcs: duplicate-key-escaped
  stricter than serde_jcs: duplicate-key-nested
  stricter than serde_jcs: integer-precision-loss
  stricter than serde_jcs: integer-precision-loss-boundary

CROSS-CHECK: PASS
```

The five are the two deviations above. The script fails if that list changes
without `edge-cases.json` being updated to match, so a deviation cannot be
acquired silently.

## Recommended implementations

For anyone writing a verifier rather than using this CLI:

| Language | Package | License |
| --- | --- | --- |
| Rust | [`serde_jcs`](https://crates.io/crates/serde_jcs) | Apache-2.0 / MIT |
| JavaScript / TypeScript | [`canonicalize`](https://www.npmjs.com/package/canonicalize) | Apache-2.0 |

Both are cross-checked above. Neither rejects duplicate member names, so a
verifier built on them should reject duplicates before parsing if it wants the
guarantee this CLI gives.

## Still open

- #5 — the byte-level specification of the commitment layout and its full
  conformance vector set. The canonicalization vectors here are its
  manifest-side half.
