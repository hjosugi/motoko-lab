#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/toolchain_env.sh"
motoko_add_toolchain_to_path

for command in mops; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing $command. Run ./scripts/bootstrap_toolchain.sh first." >&2
    exit 1
  fi
done

for app in "$root"/apps/*; do
  [[ -d "$app" && -f "$app/mops.toml" ]] || continue
  echo "==> $(basename "$app")"
  (
    cd "$app"
    # `mops install` needs the Mops registry, which lives on the Internet
    # Computer. Where `icp-api.io` is blocked - sandboxes, CI runners, egress
    # allowlists - fall back to vendoring `mo:core` into `.mops/` directly. The
    # remaining commands only need the package to be present, not the registry.
    if ! mops install; then
      echo "mops install failed; vendoring mo:core offline" >&2
      "$root/scripts/vendor_core_offline.sh" "$app"
    fi
    mops check
    if mops --help 2>&1 | grep -qE '(^|[[:space:]])test([[:space:]]|$)'; then
      mops test
    fi
    mops build
  )
done
