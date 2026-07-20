#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
    mops install
    mops check
    if mops --help 2>&1 | grep -qE '(^|[[:space:]])test([[:space:]]|$)'; then
      mops test
    fi
    mops build
  )
done
