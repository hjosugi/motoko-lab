# Creator and verifier frontend

Candid UI is not a creator workflow and not a public verifier. This directory
is the reference frontend: `client.mjs` is the logic that must be right,
`client.test.mjs` proves it offline, and `index.html` is a static view over it
with no framework, no build step and no CDN. Issue #26.

## Why the logic is separate

Everything that could silently lie to a creator lives in `client.mjs`, and the
tests compare it against the independent implementations:

| Concern | Client | Compared against |
|---|---|---|
| Artifact hashing | Web Crypto SHA-256, locally | the published SHA-256 vector and the streamed file digest |
| Manifest hashing | RFC 8785 canonical JSON, locally | `protocol/tools/jcs.mjs` (the CLI's canonicalizer) |
| Commitment | the documented v1 layout, built with Web Crypto | `protocol/tools/commitment.mjs` |
| Record digest | the `RecordDigest.mo` encoding | `test/record-digest.mjs` |
| Warnings | `WARNING_COPY` | `privacy/warnings.json`, verbatim |

The browser never has to be trusted with an encoding rule: the same bytes the
canister computes are recomputed here and compared in the test suite.

## The creator flow, in under five minutes

1. **Choose the artifact.** The file is hashed locally; it is never uploaded by
   this client. The hash is the artifact digest.
2. **Describe it.** Title, kind, MIME type and an optional storage pointer.
   The field notes say which fields are public and permanent; the storage
   pointer is the one to leave empty for private work.
3. **Read the warnings and acknowledge.** `irreversible-publication`,
   `no-personal-data`, `private-evidence-off-chain` — the copy is fixed by
   `privacy/warnings.json`, and the commit button stays disabled until the box
   is checked.
4. **Commit.** The client generates a random 16–64 byte salt, builds the
   commitment from the caller's principal, the manifest hash and the salt, and
   calls `commit({ commitmentHash, metadataHash, expiresAt })`. Only the
   commitment hash leaves the device. The pending state (commitment id, salt,
   manifest hash, artifact hash) is stored locally.
5. **Reveal.** In the same visit or a later one, `loadPending` recovers the
   salt and the reveal calls
   `reveal({ commitmentId, artifactHash, manifestHash, salt, title, kind,
   mimeType, storageUri, parents, ai, algorithm, collection })`.
6. **Verify.** The verifier fetches the record and its certificate, checks the
   certificate with a trusted subnet key (a BLS verifier, not part of this
   module), recomputes the record digest locally and compares it with the
   attested one. A mismatch is reported as tampering; a revoked record is
   prominent, never hidden.

`index.html` performs steps 1, 2, 3, the pending-reveal panel and step 6's
local check. The two canister calls need an agent (`@dfinity/agent` or the
bindings `icp` generates); the page deliberately stops at the local half so it
can run with no network. The call shapes above are the contract.

## Recovery after an interrupted reveal

A commit that is never revealed stays open until it is cancelled; a browser
closed between the two steps loses nothing because the pending state is on the
device, not in memory. `savePending`/`loadPending`/`clearPending` are the whole
mechanism, and the test asserts the stored object has exactly the recovery
fields — the salt and hashes — and no artifact. Losing the device before the
reveal loses the salt, which is why the UI shows the pending state and tells
the creator to keep it; cancelling the commitment is the alternative.

## Accessibility and mobile

- One column, no horizontal scrolling down to 320 px; inputs and buttons are
  full width and at least 44 px tall.
- Every control has a label; the warnings are text, not colour alone; the
  verdict is a sentence, not only red/green.
- The verification result is announced by setting the text of a live region
  (`#verdict`) so a screen reader reads it.
- The flow works with the keyboard alone; the file input and the checkbox are
  native controls.

## Test plan mapping

| Issue test | Where |
|---|---|
| Interrupted reveal | `client.test.mjs`: save/load/clear, exact recovery fields |
| Large file | streamed 8 MiB file digest equals the in-memory digest |
| Offline hash | hashing, canonicalization and both encodings run with `fetch` disabled |
| Gateway tampering | a record with a rewritten `storageUri` fails verification and says so |
| Warnings | every UI copy is verbatim from `privacy/warnings.json` |

## What is not built

- **Deployment.** The static files are not yet wired into an asset canister in
  `icp.yaml`; an operator can serve them from any asset canister, and the
  bindings path is the one above.
- **Internet Identity.** Login and organization membership are #27; this
  client assumes an actor with the caller's identity.
- **Production polish.** Copy review, design system and browser matrix testing
  are product work, not correctness work; the correctness half is tested here.
- **Dispute and marketplace views.** This frontend covers the registry's
  create/verify loop; the other apps keep their Candid interfaces for now.
