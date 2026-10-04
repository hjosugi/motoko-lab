#!/usr/bin/env bash
# Freeze the security-audit scope (issue #21).
#
# Writes security/audit/FROZEN.json with the commit, the tree hash, and every
# canister's module hash and Candid hash, so the auditor and the remediation
# commits can both point at one immutable artifact. The working tree must be
# clean: a freeze that includes uncommitted files is not a freeze.
#
#   scripts/freeze_audit_scope.sh
#
# Requires the pinned toolchain (scripts/bootstrap_toolchain.sh) and the app
# dependencies (mops install). CI does not run this; it runs when an engagement
# starts, and the result is committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is dirty; commit the freeze inputs first" >&2
  git status --short >&2
  exit 1
fi

source "$ROOT/scripts/toolchain_env.sh"
motoko_add_toolchain_to_path

commit="$(git rev-parse HEAD)"
tree="$(git rev-parse HEAD^{tree})"
frozen_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
out="security/audit/FROZEN.json"
mkdir -p security/audit

{
  printf '{\n'
  printf '  "format": "motoko-lab:audit-freeze:v1",\n'
  printf '  "commit": "%s",\n' "$commit"
  printf '  "tree": "%s",\n' "$tree"
  printf '  "frozenAt": "%s",\n' "$frozen_at"
  printf '  "canisters": [\n'
  first=1
  for app in apps/*/; do
    [[ -f "$app/mops.toml" ]] || continue
    project="$(basename "$app")"
    ( cd "$app" && mops build >/dev/null )
    for wasm in "$app".mops/.build/*.wasm; do
      name="$(basename "$wasm")"
      module_hash="$(sha256sum "$wasm" | cut -d' ' -f1)"
      did="$(find "$app" -path '*/candid/*.did' | head -1)"
      candid_hash="$(sha256sum "$did" | cut -d' ' -f1)"
      [[ $first -eq 1 ]] || printf ',\n'
      first=0
      printf '    {"app": "%s", "module": "%s", "moduleSha256": "%s", "candid": "%s", "candidSha256": "%s"}' \
        "$project" "$name" "$module_hash" "${did#"$ROOT"/}" "$candid_hash"
    done
  done
  printf '\n  ],\n'
  printf '  "threatModel": "docs/05_SECURITY_THREAT_MODEL.md",\n'
  printf '  "scope": "docs/33_SECURITY_AUDIT.md"\n'
  printf '}\n'
} > "$out"

echo "frozen $commit -> $out"
