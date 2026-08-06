# Commitment layout v1 — frozen

Issue #5. This is the byte layout `apps/01_creator_proof_registry` recomputes
on-chain and any verifier recomputes off-chain. Once a record exists on mainnet
the layout cannot change, because changing it invalidates every commitment ever
made. So v1 is defined here exactly, and everything a future version might want
to alter gets a new version rather than an edit to this document.

The implementation is `protocol/tools/commitment.mjs` (verifier side),
`protocol/tools/principal.mjs` (principal validation) and
`apps/01_creator_proof_registry/backend/src/Commitment.mo` (canister side).

## Grammar

ABNF as in RFC 5234, over octets. `%x` values are octets, not characters.

```abnf
preimage        = domain %x00 principal %x00 manifest-digest %x00 salt

domain          = %s"icp-creator-proof:v1"      ; 20 octets, US-ASCII

principal       = group *(dash group)
group           = 1*5 base32-char
dash            = %x2D                          ; "-"
base32-char     = %x61-7A / %x32-37             ; "a".."z" / "2".."7"

manifest-digest = 32OCTET
salt            = 16*64OCTET

commitment      = 32OCTET                       ; SHA-256(preimage)
```

The grammar admits principal strings that are not principals; see
[Principal](#principal) for the rules the grammar cannot express.

`preimage` is therefore `20 + 1 + |principal| + 1 + 32 + 1 + |salt|` octets:
79 at minimum (`aaaaa-aa` with a 16-octet salt) and 182 at maximum (a
63-character principal with a 64-octet salt). Both are accept vectors —
`principal-empty-blob` and `salt-maximum` — and the suite asserts the length of
every preimage it produces.

## Fields

### domain

The exact octets `69 63 70 2d 63 72 65 61 74 6f 72 2d 70 72 6f 6f 66 3a 76 31`,
which is `icp-creator-proof:v1` in US-ASCII. The trailing `v1` is the version:
a future layout uses a different domain string, so a v1 preimage can never be
reinterpreted under v2 rules even if every other field happened to line up.

### principal

The Internet Computer principal textual form, as defined in the Interface
Specification under "Textual representation of principals", in canonical form:

- lowercase, unpadded RFC 4648 base32 over the alphabet `abcdefghijklmnopqrstuvwxyz234567`;
- grouped in five characters separated by `-`, with the final group holding the
  remainder;
- the decoded octets are `CRC32(blob)` as four big-endian octets followed by
  `blob`, where `blob` is at most 29 octets.

A string is a valid principal exactly when it decodes under those rules, the
checksum matches, and re-encoding the decoded blob reproduces the string
character for character. The round trip is what makes the form canonical: it
refuses a mis-grouped string, or one whose trailing bits are non-zero, that
would otherwise decode to the same blob. Two spellings of one creator would be
two commitments for one creator.

Consequences fixed by those rules:

- the length is 8 to 63 characters — 8 is `aaaaa-aa`, the empty blob, which is
  the management canister; 63 is a 29-octet blob;
- the octets are drawn from `%x61-7A`, `%x32-37` and `%x2D`, so **`%x00` cannot
  occur inside a principal**;
- uppercase is not canonical. It is **rejected, not lowercased**. Silently
  normalizing would teach callers that the field is case-insensitive when the
  octets that get hashed are not.

The canister does not parse principals. It derives this field from
`Principal.toText(caller)`, which is canonical by construction and never comes
from the request — which is what stops a caller committing under someone else's
name. Its length check is a defensive assertion, not a parser. All of the above
is the *verifier's* obligation, because the verifier is where a principal
arrives as untrusted text.

### manifest-digest

Exactly 32 octets: SHA-256 over the RFC 8785 canonical form of the manifest.
See `protocol/CANONICALIZATION.md`. Read positionally and never scanned, so the
`%x00` octets it may contain are not separators.

### salt

16 to 64 octets, chosen by the creator, and at least 128 bits of entropy. It is
public at reveal time; its only job is to stop a commitment being brute-forced
before the reveal. It is the last field, so the `%x00` octets it may contain
cannot be mistaken for a separator either.

## No concatenation ambiguity

Every field boundary is recoverable from the octets alone:

1. `domain` is a fixed 20-octet literal.
2. The next octet is `%x00`.
3. `principal` runs to the next `%x00`, which is unambiguous because a principal
   cannot contain `%x00`.
4. `manifest-digest` is the next 32 octets, read by position.
5. The next octet is `%x00`.
6. `salt` is everything remaining.

`parsePreimage` in `protocol/tools/commitment.mjs` implements exactly that, and
the conformance suite asserts for every accept vector that the three fields come
back out unchanged. The suite also asserts that no two distinct triples in the
vector set produce the same commitment. The layout being injective is therefore
a checked property, not a claim in prose — which is why `salt-all-zero`,
`salt-leading-zero` and `digest-all-zero` are vectors.

## Error behaviour

A verifier refuses, rather than repairing, anything that is not exactly the
above. The refusals are enumerated in the `reject` array of
`protocol/test-vectors/commitment/vectors.json`, each pinned to the message
`protocol/tools/commitment.mjs` produces, so failure behaviour is part of the
contract rather than an implementation detail.

The *message wording* is fixed only for that implementation. What the
specification fixes is which inputs are refused; an independent implementation
words its own errors.

Only two normalizations are performed, and neither can change which triple is
meant:

- surrounding whitespace on the principal is trimmed, because a trailing newline
  from a shell pipeline is not a different principal;
- hexadecimal input is case-insensitive, because it denotes octets.

Both have explicit accept vectors (`principal-whitespace-trimmed`,
`salt-uppercase-hex`, `digest-uppercase-hex`) that assert they produce the same
commitment as the plain form.

The canister's refusal is coarser by design: `reveal` returns `#invalidInput`
without saying which of the three fields did not match, because saying would
tell a caller probing someone else's commitment which field to vary next.

## Version negotiation

Three things carry the version, and they cannot disagree:

| Where | Value | Effect |
| --- | --- | --- |
| `domain` in the preimage | `icp-creator-proof:v1` | a v2 preimage hashes differently, so a v1 commitment can never be satisfied by a v2 reveal |
| `RevealInput.algorithm` | `opt variant { sha256V1 }` | selects the layout at reveal time; `null` means v1 |
| `commitmentSpec()` | a `CommitmentSpec` record | what the deployed canister implements, readable before committing |

Rules:

1. **v1 behaviour cannot change.** Any change to the octets a triple produces is
   a new version with a new domain string, a new `Algorithm` tag, and new
   vectors. This document and
   `protocol/test-vectors/commitment/vectors.json` are the definition of what v1
   is; a change to either that alters an existing vector is a bug, not a
   revision.
2. **Nothing stores which version a commitment used, and nothing needs to.** The
   version selects the preimage, the preimage determines the digest, and the
   digest is what `commit` stored, so a reveal naming the wrong version fails
   the same comparison as one naming the wrong salt. The choice is
   self-authenticating, which is why adding a version needs no migration of
   stable state.
3. **A client discovers rather than assumes.** `commitmentSpec()` returns the
   domain, layout, algorithm, digest size and both size ranges, so a verifier
   can rebuild the preimage from the deployed canister rather than from a
   document it hopes matches.
4. **A canister may accept more than one version at once.** Adding a tag to
   `Algorithm` is a Candid-compatible change on the argument side; removing one
   is not, so support is added but never silently withdrawn.

## Conformance vectors

`protocol/test-vectors/commitment/vectors.json`: 17 accept, 22 reject.

Each accept vector pins the principal, the manifest digest, the salt, the full
preimage in hexadecimal, its length, and the commitment. Each reject vector pins
the input and the exact error.

Coverage, against the test plan in issue #5:

| Case | Vectors |
| --- | --- |
| Empty and invalid principal | `principal-empty`, `principal-not-a-principal`, `principal-too-short`, `principal-too-long`, `principal-bad-checksum`, `principal-non-canonical-padding`, `principal-double-dash`, `principal-trailing-dash`, `principal-ungrouped`, `principal-invalid-base32` |
| Uppercase input | `principal-uppercase`, `principal-mixed-case` (rejected); `salt-uppercase-hex`, `digest-uppercase-hex` (accepted, and equal to the lowercase form) |
| Boundary salt sizes | `salt-minimum` (16), `salt-maximum` (64), `salt-15-bytes`, `salt-65-bytes`, `salt-empty` |
| Wrong digest length | `digest-31-bytes`, `digest-33-bytes`, `digest-empty`, `digest-odd-hex`, `digest-non-hex` |
| Principal blob sizes | `principal-empty-blob` (0 octets), `principal-anonymous` (1), `principal-canister` (10), `principal-self-authenticating` (29) |
| Separator octets inside fields | `salt-all-zero`, `salt-leading-zero`, `digest-all-zero` |

The two vectors published before this freeze — `published-human-only` and
`published-ai-assisted` — reproduce the commitments in
`protocol/test-vectors/test-vectors.json` unchanged. Freezing the layout did not
move it.

## Independent implementations

Acceptance for #5 requires that implementations sharing no code with the
reference pass every vector. Two do, both written from this document:

| | File | Principal validation |
| --- | --- | --- |
| Rust | `protocol/tools/crosscheck/commitment.rs` | `candid::Principal` |
| TypeScript | `protocol/tools/crosscheck/commitment.ts` | `@dfinity/principal` |

Neither uses the base32 and CRC32 code in `protocol/tools/principal.mjs`; both
use DFINITY's own libraries. If the principal rules here disagreed with
DFINITY's, or if this document were not implementable from its own text, that is
where it would show.

`node protocol/tools/crosscheck.mjs`, last run 2026-08-07 on `candid` 0.10.34,
`sha2` 0.11.0, `@dfinity/principal` 3.4.3:

```
commitment: 17 accepted and 22 rejected, same verdict and same bytes from
crosscheck/commitment.rs and crosscheck/commitment.ts

CROSS-CHECK: PASS
```

The Motoko implementation reproduces all 14 accept vectors that do not exist
purely to pin parsing behaviour, in
`apps/01_creator_proof_registry/test/Commitment.test.mo`, run by `mops test`.

The cross-check needs `cargo`, `npm` and network access, so it is deliberately
outside `scripts/run_offline_checks.sh` and outside CI. The vectors themselves
are asserted offline by `protocol/tools/provenance-cli.test.mjs`.

## What changed at the freeze

The layout did not. These did:

- **Principal validation.** It was a length check accepting any string of 5 to
  100 characters, so `hello` and `not-a-principal` produced perfectly good
  commitments that no canister could ever match. It is now the full textual
  form, checksum and canonical spelling included, and the bounds are the real
  ones (8 to 63).
- **Uppercase principals.** Previously lowercased in silence; now rejected.
- **Motoko's bounds** moved from 5..100 to 8..63 to match.
- **`commitmentSpec()`** gained `version`, `minPrincipalTextSize` and
  `maxPrincipalTextSize`, so the published rules are complete enough to rebuild
  the preimage from.
