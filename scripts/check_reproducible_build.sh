#!/usr/bin/env bash
# Builds every canister twice, from two clean copies at different paths, and
# requires byte-identical Wasm (#29).
#
# A module hash is only evidence of what is running if someone other than the
# person who deployed it can rebuild the same bytes. That breaks quietly: a
# build that embeds its working directory, a timestamp, or whatever package
# versions happened to be cached gives a different hash on every machine, and
# "verify the module hash" becomes "trust the deployer". Two clean copies at
# different paths, each with its own `mops install` from the lockfile, is the
# cheapest test that catches all three.
#
# The copies are made from the files git tracks, so nothing untracked (a stale
# `.mops/`, a local build) can make the two agree for the wrong reason.
#
# Usage:
#   scripts/check_reproducible_build.sh                  # every app
#   scripts/check_reproducible_build.sh apps/02_merkle_anchor
#   REPORT=validation/module-hashes.json scripts/check_reproducible_build.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/toolchain_env.sh"
motoko_add_toolchain_to_path

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if (( $# )); then
  projects=("$@")
else
  projects=()
  for app in "$root"/apps/*/; do
    [[ -f "$app/mops.toml" ]] && projects+=("apps/$(basename "$app")")
  done
fi

copy_tracked() {
  local project="$1" destination="$2"
  mkdir -p "$destination"
  (cd "$root" && git ls-files -z -- "$project" scripts | tar --null -T - -cf -) | tar -xf - -C "$destination"
}

build() {
  local dir="$1"
  (
    cd "$dir"
    if ! mops install >/dev/null 2>&1; then
      "$dir/../../scripts/vendor_core_offline.sh" "$dir" >/dev/null
    fi
    mops build >/dev/null
  )
}

failed=0
report="["
for project in "${projects[@]}"; do
  first="$work/a/$project"
  second="$work/b/deeper/path/$project"
  copy_tracked "$project" "$work/a"
  copy_tracked "$project" "$work/b/deeper/path"
  build "$first"
  build "$second"
  for wasm in "$first"/.mops/.build/*.wasm; do
    name="$(basename "$wasm")"
    one="$(sha256sum "$wasm" | cut -d' ' -f1)"
    two="$(sha256sum "$second/.mops/.build/$name" | cut -d' ' -f1)"
    if [[ "$one" == "$two" ]]; then
      echo "  ok   $project/$name $one"
    else
      echo "  FAIL $project/$name differs between clean builds: $one vs $two"
      failed=1
    fi
    report+="{\"project\":\"$project\",\"wasm\":\"$name\",\"sha256\":\"$one\",\"reproduced\":$([[ "$one" == "$two" ]] && echo true || echo false)},"
  done
done
report="${report%,}]"

if [[ -n "${REPORT:-}" ]]; then
  printf '%s\n' "$report" | python3 -m json.tool > "$REPORT"
  echo "report: $REPORT"
fi

if (( failed )); then
  echo "Status: FAIL"
  exit 1
fi
echo "Status: PASS"
