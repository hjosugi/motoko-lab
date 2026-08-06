# Commitment v1 — on-chain verification

Issue #3. Before this, `reveal` stored `commitmentHash` and the revealed
principal, manifest hash and salt side by side and never checked that the second
set produces the first. A caller could commit to one digest and reveal something
entirely unrelated; the registry recorded it as a valid proof, and only an
off-chain verifier running `provenance-cli verify-commitment` would notice —
which is to say, only someone who already suspected the record. The commitment
was not binding, so the front-running defence it exists for did not hold.

The canister now recomputes the digest and rejects a reveal that does not match.

## Layout

```
SHA-256( domain || 0x00 || principalText || 0x00 || manifestHash || 0x00 || salt )

domain        = "icp-creator-proof:v1"   20 bytes, ASCII
principalText = Principal.toText(caller) 5..100 bytes, lowercase base32 with dashes
manifestHash  = SHA-256(canonical manifest JSON)   exactly 32 bytes
salt          = caller-chosen                      16..64 bytes
```

This is the layout `protocol/tools/provenance-cli.mjs` already implemented, kept
byte for byte so the Node verifier and the canister cannot disagree.

There is no concatenation ambiguity. Every field is either fixed length or
terminated by the `0x00` separator, and `0x00` cannot occur inside any of them:
the domain is a fixed ASCII literal, `principalText` is base32 with dashes, and
`manifestHash` is exactly 32 bytes read positionally. A `0x00` byte inside the
salt is harmless because the salt is last.

`Principal.toText` is already the canonical form — lowercase, no surrounding
whitespace — so the canister does no normalization. The Node CLI reaches the
same string by trimming and lowercasing whatever text it was handed, which is a
step the canister does not need because it never receives the principal as text.
It is the *caller's* principal that goes into the preimage, never a value from
the request, so a caller cannot commit under someone else's name.

A byte-level specification with the full positive and negative vector set is
issue #5; this document covers what the implementation of #3 fixed.

## Version agility

`Commitment.Algorithm` names both the hash function and the layout, so a future
layout gets a new tag rather than redefining what `#sha256V1` meant. `v2` will
also get a new `domain` string, so a v1 preimage can never be reinterpreted
under v2 rules.

`RevealInput.algorithm` is an *optional* field. `null` means v1, so clients
written before this change keep working, and `didc` accepts the addition — the
`optional-argument-field` fixture in `validation/candid-fixtures/` is the case.

Nothing records which algorithm a commitment used, and nothing needs to. The
algorithm selects the preimage, the preimage determines the digest, and the
digest is what `commit` stored, so a reveal naming the wrong algorithm fails the
same comparison as one naming the wrong salt. The choice is self-authenticating
and stays out of stable state, which is why this change needs no migration.

`commitmentSpec()` publishes the rules a verifier needs, so a client can tell a
v1 registry from a later one without inferring it from a failed reveal.

## Why `mo:sha2`, not a hand-written module

| | |
|---|---|
| Package | [`sha2`](https://mops.one/sha2) 0.2.5 |
| Source | https://github.com/research-ag/sha2 |
| License | Apache-2.0 — same as this kit, no notice obligations beyond `THIRD_PARTY_NOTICES.md` |
| Maintenance | Published 2026-06-22; `core` is its only dependency |
| Scope used | `Sha256.fromBlob` only |

Issue #3 allowed either a maintained package or a reviewed minimal
implementation. The package wins: SHA-256 is easy to write and easy to write
subtly wrong, the failure is silent, and a hand-rolled copy would need the same
vector suite plus an ongoing reviewer. `sha2` is optimized, widely used in the
Motoko ecosystem, and pulls in nothing but `core`.

One cost is real and worth stating. `research-ag/sha2` tags releases on GitHub
only up to `0.2.4`, so there is no pinned tree for `0.2.5` on
raw.githubusercontent.com and `scripts/vendor_core_offline.sh` cannot fetch it
the way it fetches `mo:core`. It copies the package out of the Mops global cache
instead, which needs one online `mops install` on the machine first. Pinning the
app to a tagged-but-older release to suit the vendoring script would be the tail
wagging the dog.

## Conformance

`test/Commitment.test.mo`, run by `mops test`:

- The four FIPS 180-4 SHA-256 examples, including a 112-byte message that spans
  two compression blocks after padding. The one-million-`a` example is left out:
  it says nothing the two-block case does not and it makes `mops test` take
  minutes under the interpreter.
- `Commitment.preimage` compared byte for byte, so a change to the separator,
  the domain string or the field order fails there rather than as an opaque
  digest mismatch.
- Both published `protocol/test-vectors/test-vectors.json` entries, plus the
  16-byte and 64-byte salt boundaries.
- Each of the three bound fields changed on its own, and a single flipped salt
  bit, all of which must break the match.

Every expected value was produced by Node's `crypto` and cross-checked against
the CLI's own `commitmentHex`; the two agree.

## Cost

`mops bench --replica pocket-ic` (pocket-ic 14.0.0, moc 1.11.1), instructions
per call, by salt size in bytes:

| | 16 | 40 | 64 |
| :--- | ---: | ---: | ---: |
| `preimage` | 30_511 | 35_368 | 39_984 |
| `digest` | 97_456 | 104_689 | 111_713 |
| `matches` | 97_406 | 104_639 | 111_631 |

Heap grows 38.18 → 39.96 KiB across the same range and no garbage collection
runs. A 16-byte salt makes a 79-byte preimage, which SHA-256 pads to two 64-byte
blocks; a 64-byte salt makes 127 bytes, which pads to three.

So the check costs the registry roughly 100k instructions on top of a `reveal`,
and about 1.8 KiB of heap that the collector never has to reclaim. The salt
range the registry accepts moves that by 15%, not by an order of magnitude, so
there is no input a caller can choose to make verification expensive.

Measuring it from outside the canister does not resolve it. Forty `icp canister
call backend reveal` invocations per batch, idle burn subtracted:

```
A no-hash  (unknown id -> notFound)     per_call=9_218_180 cycles
B hash-79B (16-byte salt -> mismatch)   per_call=9_221_409 cycles
C hash-127B(64-byte salt -> mismatch)   per_call=9_308_945 cycles
```

The ~9.2M cycles an update call costs regardless of branch swamps the ~100k the
check adds, and B and C are not even a clean pair — the larger salt also makes a
larger ingress message, which is charged per byte. The numbers are consistent
with the benchmark to within their resolution, and that is all they establish.

## Evidence

Local network, `icp` 1.2.0, network launcher 15.0.0, moc 1.11.1, `mo:core`
2.6.0, `mo:sha2` 0.2.5, `didc` 0.4.0.

```
mops check                       # ok
mops test                        # test/Validation.test.mo, test/Commitment.test.mo
python3 scripts/check_candid_compat.py . --self-test    # drift ok, compat ok
icp network start -d && icp deploy
```

Against the deployed canister, one commitment per case:

| Case | Result |
|---|---|
| correct principal, manifest hash and salt | `ok`, record 1 created |
| wrong salt | `err invalidInput "commitment hash does not match …"` |
| wrong manifest hash | `err invalidInput "commitment hash does not match …"` |
| commitment whose preimage names another principal | `err invalidInput "commitment hash does not match …"` |

The last case is the one that shows the principal binding, and it is not the
obvious one. Calling `reveal` from a stranger's identity proves nothing: the
ownership check returns `#unauthorized` before anything is hashed. What
exercises the binding is the *owner* revealing a commitment whose preimage names
somebody else — ownership passes, the digest does not.

## Why the error is `#invalidInput` and not a new tag

A distinct `#commitmentMismatch` tag would read better. It is also a breaking
Candid change: `Error` appears inside `CommitmentResult` and `RecordResult`, and
Candid's special `opt` rule lets a client written against the released interface
decode an unknown result tag as `null` rather than trap. The call would succeed
and the client would silently see nothing, which is why
`scripts/check_candid_compat.py` treats `didc`'s `FIX ME!` banner as a break.
A new tag here is worth a major-version interface change, not a side effect of
this fix.

## Still open

- #4 — the manifest hash this commitment binds is only as good as the
  canonicalization that produced it, and the CLI's is a recursive key sort, not
  RFC 8785.
- #5 — byte-level specification and the full conformance vector set.
- #2 — these canister-level cases were run by hand against a local deploy; they
  belong in the PocketIC suite.
