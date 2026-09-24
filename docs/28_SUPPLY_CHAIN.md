# Dependency provenance and reproducible builds

Issue #29. The compiler, the Mops packages, the npm tools, the replica, the
docs toolchain and the CI actions are all part of what a released canister is
built from. A module hash is evidence of what is running only if someone other
than the deployer can rebuild the same bytes, from dependencies someone
reviewed.

## What is locked, and where

| Layer | Pin | Integrity |
|---|---|---|
| Mops packages, direct and transitive | each project's `mops.lock` | a SHA-256 for **every file of every package**; `mops install` refuses a package whose files differ ("Checking integrity") |
| compiler | `[toolchain] moc = "1.11.1"` in every `mops.toml` | fetched by `mops` for that exact version |
| replica | `pocket-ic` 14.0.0 in `tools/pocket-ic/setup.mjs` and `mops.toml` | release asset of that tag |
| `didc` | release `2024-07-29` in `setup.mjs` and `scripts/install_didc.sh` | release asset of that tag |
| npm CLIs | `ic-mops` 2.20.0, `@icp-sdk/icp-cli` 1.2.0, `@icp-sdk/ic-wasm` 0.11.1 in `scripts/bootstrap_toolchain.sh` | npm registry integrity |
| replica harness | `@dfinity/pic` 0.22.0, `@dfinity/agent` 3.4.3, `@dfinity/candid` 3.4.3, exact, in `tools/pocket-ic/package.json` | npm registry integrity |
| docs toolchain | `mkdocs` 1.6.1, `mkdocs-material` 9.7.7 in `requirements-docs.txt` | PyPI |
| CI | every `uses:` in `.github/workflows/` | major-version tags (see CI image drift) |

Two of these were not pinned before this change, and both were ways for the
build to change without a commit: `bootstrap_toolchain.sh` installed whatever
version of the three CLIs npm served that day, and the harness depended on
caret ranges with its lockfile gitignored. Both are exact now.

## The reviewed inventory

`supply-chain/dependencies.json` records, for every one of those — 18 Mops
packages, 6 toolchain components, 3 npm packages, 2 Python packages, 5
actions — the exact version, license, source repository, maintainer and why it
is there. `scripts/check_supply_chain.py` (in CI) fails when the tree and the
inventory disagree:

- a package in any `mops.lock` that is not in the inventory at that version, or
  an inventory entry no lock uses;
- a lock entry without a SHA-256 for every file;
- a toolchain pin that is a range, or differs from the reviewed version;
- a workflow action not in the inventory at the ref it is used at;
- a license outside the allowlist.

So a dependency cannot be added, bumped, or swapped by a lockfile edit without
the same review showing an edit to `supply-chain/dependencies.json`. The
script's `--self-test` mutates the inventory five ways — an unreviewed package,
a silently changed version, an incompatible license, a compiler pin that differs
from the reviewed one, an unreviewed action ref — and fails unless each is
caught.

`--sbom PATH` writes a CycloneDX 1.5 SBOM of the same inventory; each Mops
component carries a SHA-256 computed from its lock's per-file hashes, so the
SBOM identifies the exact source that was built.

**Licenses.** The allowlist is Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause and
ISC — all compatible with distributing the kit under Apache-2.0. Every current
dependency is Apache-2.0, MIT or BSD-2-Clause. `mo:ic-certification`'s
`mops.toml` does not state a license; its repository's LICENSE is Apache-2.0,
which is what the inventory records.

## Reproducible Wasm

`scripts/check_reproducible_build.sh` (in CI) copies every application from the
files git tracks into two clean directories at different paths, runs
`mops install` from the lockfile in each, runs `mops build`, and requires
byte-identical Wasm. Nothing untracked — a stale `.mops/`, a local build — can
make the two agree for the wrong reason, and a build that embedded its path, a
timestamp, or whatever happened to be cached would differ.

All 11 canisters reproduce (moc 1.11.1, ic-mops 2.20.0); the hashes at this
commit:

| Canister | SHA-256 of the `mops build` Wasm |
|---|---|
| 01 backend | `1dbdd1847caff06ba0517a7f0472d76407b40ecb64f5588d2a6ca268d30a268e` |
| 02 backend | `2ce8bd58451c04d9a795400cdf7362689a9e076505844664085e9e4e68806a14` |
| 03 backend | `5c969b9945f27ec27ef78abee6ec3f05279df7c6d0775bd88d22cee918db47e1` |
| 04 backend | `20c5c1d17024c93d5526acac848ac8cd0489f055a567626142bdf5146bce4502` |
| 05 backend | `c48fd1ab5c86a3d415fc8309698d03a3cb16d16e84e735835fdc93fb73d52e51` |
| 06 backend | `7a0ffb77aa369ebaa7a7793b0b31231ed9d3bd1e253eda78caacc11ae6d2c3af` |
| 06 llm_shim | `c731dd6409389b3881303d29ce4f5f0472f20eca7ba6f16a5175069c7771c17e` |
| 06 worker_0–3 | `9e3a3fd2eef8e87b81c2291cd2f64c4ebddcbf4a63a68aee557fca9e98ac704d` |

`REPORT=validation/module-hashes.json scripts/check_reproducible_build.sh`
writes them as JSON for a release.

**What this does not yet prove.** A canister deployed with `icp deploy` is built
by the `@dfinity/motoko@v5.0.0` recipe, which invokes the compiler itself and
may add metadata, so the deployed `module_hash` is the recipe's output, not
`mops build`'s. Checking that a deployed module hash matches a reproducible
build is part of the mainnet release process (#28), which is where the recipe
build is run twice the same way.

## Release artifacts

Each kit release publishes the ZIP, its SHA-256, and `MANIFEST.sha256`, which
lists every file in the kit with its own SHA-256; `scripts/package_kit.py`
verifies the manifest against the tree before zipping and the ZIP's entries
against the manifest after. A reader verifies a download with
`sha256sum -c motoko-mastery-kit-<version>.zip.sha256`, and any file in it
against `MANIFEST.sha256`.

## Reviewing a dependency update

1. Change the pin (`mops add`, `mops update`, a version in
   `bootstrap_toolchain.sh`, `package.json`, `requirements-docs.txt`, or a
   workflow).
2. Update `supply-chain/dependencies.json` in the same change: version, and
   license / source / maintainer if they moved. `check_supply_chain.py` fails
   until you do — that is the review prompt.
3. Read the upstream changelog and diff for the versions crossed, for Motoko
   packages especially: they run inside the canister with its full authority.
4. Run the gates: `check_all_apps.sh` (the lock is verified on install),
   `check_candid_compat.py`, the replica suites, and
   `check_reproducible_build.sh`. A compiler or package change changes module
   hashes; record the new ones in the release.
5. For a new package: prefer none. A cryptographic dependency needs a stated
   reason in `mops.toml` and a test vector from outside the package — the
   pattern of `sha2` (FIPS 180-4 vectors), `ic-certification` (a second
   implementation of the digest) and `ecdsa` (a node:crypto signature, which is
   how its high-S acceptance was found in #15).

## Responding to an advisory

1. **Triage within one working day**: which projects lock the affected versions
   (`check_supply_chain.py` lists users per package; the SBOM is searchable),
   and whether the vulnerable code is reachable from a public method.
2. **Contain** if reachable and deployed: the emergency powers in
   `docs/26_GOVERNANCE_DECISION_RECORD.md` pause the affected write paths; they
   cannot install code, so containment and fix are separate steps.
3. **Fix** by updating through the review above, or by vendoring a patched copy
   with the reason recorded, and ship a release whose notes name the advisory.
4. **Verify** the fix is what runs: the new module hash, reproduced, announced.

## Test plan

| Case | Evidence |
|---|---|
| compromised package | a lock whose recorded hash for one file of `sha2@0.2.5` was altered makes `mops install` exit 1 with "Actual hash … your lockfile may be stale or corrupt"; a package whose content differs from the lock is refused the same way. A package swapped *with* its lock is caught by `check_supply_chain.py` as an unreviewed version |
| yanked version | the lock pins exact versions and every file's hash, so a yanked version keeps building from the global cache or fails loudly; it never silently resolves to another version. The fix is an update through the review above |
| recipe update | `validate_kit.py` requires every `canister.yaml` to pin `@dfinity/motoko@v5.0.0`; changing it is a reviewed change |
| CI image drift | the CLIs are now pinned exactly, so a new runner installs the same tools; actions are pinned to major-version tags, which their maintainers can move. Pinning them to commit SHAs is the next step, and the inventory check will then enforce the SHAs just as it enforces the tags today |
