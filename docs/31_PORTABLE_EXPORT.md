# Portable export and verified restore

A canister's state survives a crash because the subnet replicates it. That is
availability, not portability: it does not give an operator a copy they can
hold, an auditor a document they can check without trusting the tool that
fetched it, or a team a way to rebuild a canister after losing one. Issue #19
adds that path for the creator proof registry: a versioned export format, a
reader that verifies it, and a restore that a fresh canister can only complete
if the result is byte-for-byte the snapshot the export named.

## What is exported

Version 1 exports the two entities the registry's evidence rests on:

- **commitments** — id, owner, commitment hash, optional metadata hash,
  committed-at, optional expiry, and status (`open`, `revealed(recordId)`,
  `cancelled(at)`), and
- **records** — every field `RecordDigest.mo` covers, including the revoked
  status with its reason and timestamp.

`exportSummary` also returns the counts (`commitments`, `records`,
`activeRecords`, `revokedRecords`) and two roots over the ordered entry
digests. `exportCommitments` / `exportRecords` stream bounded pages in id
order; `next` says where a resumed export continues.

Deliberately not in v1, and why:

- **identity, collections, delegations, recoveries and attributions** are
  authorization state, not evidence. Restoring a record's owner is enough for
  revocation and reads; restoring a delegation graph without its creators would
  be a half-truth, so it is left out rather than approximated.
- **disputes** already have a self-contained, certified export (`exportDispute`,
  #8) that a reader can verify on its own. Folding it into the state export
  would duplicate that format rather than reuse it.
- **API keys, invoices, escrow and payments** belong to other applications;
  each has its own export surface where it has one at all.

The format is extensible by adding a page kind, not by changing this one: a new
kind gets its own domain string, its own root, and its own summary count.

## The format

The byte-level rules are the same discipline as `RecordDigest.mo` and
`protocol/COMMITMENT_V1.md`: a versioned domain separator, fixed-width
big-endian integers, a length prefix on every variable-length field, a
present-flag on every optional, and a tag byte on every variant. There are two
implementations of those rules and they are compared on every replica run:

| Side | File |
|---|---|
| Canister | `backend/src/Export.mo` |
| Reader | `tools/export/format.mjs` |

An entry's digest is SHA-256 over its encoding. A **root** is SHA-256 over the
entry digests in id order with the count folded in; a **page checksum** is
SHA-256 over the page's kind, policy, start, every entry digest, and `next`.
Nothing about a page is believed until the reader has recomputed its checksum,
and nothing about a bundle is believed until the reader's roots equal the
summary the canister published.

The roots are not Merkle roots: they prove the reader holds exactly the set the
canister summarised, in order — which is what "the restore matches" means —
not membership of one entry. `apps/01_creator_proof_registry/docs/CERTIFIED_QUERIES.md`
covers the per-record Merkle tree that proves membership; the two are
complementary.

## The bundle

`collect` writes a directory, not one blob, so a crash loses at most the page
in flight:

```
bundle/
  bundle.json                 # format, source, policy, summary, page manifest, resume state
  pages/commitments-000000000000.json
  pages/records-000000000000.json
  ...
```

`bundle.json` is rewritten after every verified page. Re-running `collect`
against the same directory resumes at the first unfinished page; pages already
on disk are not fetched again, and their checksums are re-verified before the
roots are accepted.

## Policy

`ExportPolicy { includeStorageUris }` is applied **before** the digests are
computed, so a redacted export is self-consistent: its roots describe exactly
what was handed out, and a reader can say which policy it holds. A redacted
export restores the redaction, not the pointer. A full export and a redacted
one of the same state have different roots by construction, and the bundle
records the policy it was collected under so the two can never be mixed.

## Restore

Restore exists only through four controller-only endpoints, and only into a
canister that holds nothing:

1. `restoreBegin(summary)` — refuses a non-empty canister, a non-controller, an
   unknown format, or a second open restore. The summary becomes the target
   the restore must hit.
2. `restoreCommitments(entries)` / `restoreRecords(entries)` — import in id
   order. A page whose reply was lost can be retried: entries already stored
   are accepted only if byte-identical, and anything else is a conflict rather
   than an overwrite. `restoreRecords` rebuilds the artifact hash index, keeps
   the active/revoked counters, and re-certifies every record, so certified
   queries work on the restored canister.
3. `restoreFinish()` — recomputes counts and roots under the summary's policy
   and requires them to equal the summary, then requires every record to link
   to its revealed commitment and back. Only then does the restore close.

A restore that cannot finish leaves the canister in a partial state and
`restoreFinish` refuses it. Recovery is reinstalling the canister, not an abort
method: at that point the canister holds data that failed verification, and the
safe move is to discard it rather than trust a cleanup path. The empty-canister
gate is also what keeps this from being an edit path — there is no way to
import over existing state, and a controller could already install arbitrary
Wasm.

The rehearsal is in the app's replica suite (`apps/01_creator_proof_registry/test/replica.test.mjs`,
the "portable export" section): collect, redact, interrupt and resume, tamper
with a page, restore into a fresh canister, verify the indexes and a certified
query, refuse a second restore, refuse a summary that does not match, and
upgrade the restored canister without changing a byte.

## Running it

```sh
# The reader's own tests, offline.
node apps/01_creator_proof_registry/tools/export/export.test.mjs

# Prove a bundle without a network (used by the restore runbook).
node apps/01_creator_proof_registry/tools/export/cli.mjs verify <bundle-dir>

# Collect and restore need a canister actor; the SDK entry points are
# `collect` / `verify` / `restore` in tools/export/bundle.mjs. The replica
# suite shows the actor wiring, and a client holding an agent can reuse it
# against mainnet.
```

## What it does not promise

- **A snapshot is consistent only if the state is quiet.** The roots are over
  the current state, so a record revoked between two pages makes the final
  roots disagree and the export has to be retried. That is detection, not
  prevention; a frozen or read-only canister is the way to guarantee a single
  snapshot.
- **The source canister is trusted for its own state.** The format detects a
  tampered page, a replayed page, a redaction/policy mix-up and a target that
  does not reproduce the summary. It does not prove the source did not lie in
  the first place — that is what the per-record certificates (#6) are for, and
  a reader who needs it verifies records against the subnet key rather than
  against this export.
- **Multiple shards are per-canister.** The sharding design (#23) exports per
  tenant from one shard, and its model already covers rebuilding an index from
  per-shard pages. Merging pages from several shards into one canister is not
  something v1 supports, because ids and owners would collide; each shard
  restores into its own canister.

## Evidence

- `apps/01_creator_proof_registry/test/Export.test.mo` pins the validation
  table, redaction's effect on digests, and the roots' binding to count, order,
  policy and page position, in `mops test`.
- `tools/export/export.test.mjs` pins the byte vectors against the Motoko
  implementation, and exercises collect/resume/tamper/restore offline (22
  checks).
- The replica suite exports the live canister (240 checks for the app, 38 of
  them in the export/restore section) and compares the two encodings on every
  page.
- Versions: pocket-ic 14.0.0, pinned `moc` 1.11.1, Node.js 26.10.0.
