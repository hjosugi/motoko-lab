#!/usr/bin/env bash
# Populates `<app>/.mops/core@<version>` without the Mops registry.
#
# Normal machines do not need this: `mops install` fetches `core` from the Mops
# registry, which lives on the Internet Computer. Sandboxes, CI runners and
# corporate networks with an egress allowlist frequently block `icp-api.io`, and
# every `mops` command then fails with
#
#   package error [M0012], file ".mops/core@X.Y.Z/src" (for package `core`)
#   does not exist
#
# `mops check`, `mops test` and `mops build` only need the package to be present
# under `.mops/`; they do not need the registry. So this script puts it there and
# the ordinary targets keep working.
#
# Two offline sources are tried, in order:
#   1. raw.githubusercontent.com   (exact pinned tag, preferred)
#   2. the `motoko` npm package    (bundles a core snapshot as JSON)
#
# Usage:
#   scripts/vendor_core_offline.sh                 # every app under apps/
#   scripts/vendor_core_offline.sh apps/06_...     # just these

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${CORE_VERSION:-2.6.0}"
repo="${CORE_REPO:-dfinity/motoko-core}"
cache="$root/.mops-cache/core@$version"

# Module list of motoko-core. Kept explicit so vendoring needs neither a
# directory listing API (api.github.com is commonly blocked too) nor a tarball
# endpoint (codeload.github.com likewise).
modules=(
  Array Base64 Blob Bool CallerAttributes CertifiedData Char Cycles Debug Error
  Float Float32 Func Int Int8 Int16 Int32 Int64 InternetComputer Iter List Map
  Nat Nat8 Nat16 Nat32 Nat64 Option Order PriorityQueue Principal Queue Random
  Region Result Runtime Set Stack Text Time Timer Tuples Types VarArray
  WeakReference
  internal/BTreeHelper internal/PRNG internal/SortHelper
  pure/List pure/Map pure/Queue pure/RealTimeQueue pure/Set
)

fetch_from_github() {
  local base="https://raw.githubusercontent.com/$repo/v$version/src"
  local tmp
  tmp="$(mktemp -d)"
  local m status
  for m in "${modules[@]}"; do
    mkdir -p "$tmp/$(dirname "$m")"
    status="$(curl -fsSL -m 60 -o "$tmp/$m.mo" -w '%{http_code}' "$base/$m.mo" 2>/dev/null || echo 000)"
    if [[ "$status" != "200" ]]; then
      echo "  github: $m.mo -> HTTP $status" >&2
      rm -rf "$tmp"
      return 1
    fi
  done
  mkdir -p "$cache"
  rm -rf "$cache/src"
  mv "$tmp" "$cache/src"
}

fetch_from_npm() {
  local tmp
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    npm init -y >/dev/null 2>&1
    npm install --no-audit --no-fund "motoko@${NODE_MOTOKO_VERSION:-4.11.0}" >/dev/null 2>&1
  ) || { rm -rf "$tmp"; return 1; }

  local bundle="$tmp/node_modules/motoko/packages/latest/core.json"
  [[ -f "$bundle" ]] || { rm -rf "$tmp"; return 1; }

  mkdir -p "$cache"
  rm -rf "$cache/src"
  BUNDLE="$bundle" OUT="$cache/src" node -e '
    const fs = require("fs");
    const path = require("path");
    const pkg = require(process.env.BUNDLE);
    for (const [name, entry] of Object.entries(pkg.files)) {
      const dest = path.join(process.env.OUT, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.content);
    }
    console.error(`  npm: extracted core ${pkg.version} (${Object.keys(pkg.files).length} modules)`);
  '
  rm -rf "$tmp"
}

populate_cache() {
  if [[ -f "$cache/src/Array.mo" && -z "${FORCE:-}" ]]; then
    return 0
  fi
  echo "Fetching mo:core $version"
  if fetch_from_github; then
    echo "  source: raw.githubusercontent.com/$repo v$version"
  elif fetch_from_npm; then
    echo "  source: npm motoko package (bundled snapshot; may differ from v$version)"
  else
    echo "Could not fetch mo:core from any offline source." >&2
    exit 1
  fi
  echo "  cached $(find "$cache/src" -name '*.mo' | wc -l) modules in $cache"
}

install_into() {
  local app="$1"
  [[ -f "$app/mops.toml" ]] || return 0
  mkdir -p "$app/.mops"
  rm -rf "$app/.mops/core@$version"
  cp -r "$cache" "$app/.mops/core@$version"
  echo "  -> ${app#"$root/"}/.mops/core@$version"
}

populate_cache

if (( $# > 0 )); then
  for app in "$@"; do
    install_into "$(cd "$app" && pwd)"
  done
else
  for app in "$root"/apps/*; do
    [[ -d "$app" ]] && install_into "$app"
  done
fi
