#!/usr/bin/env bash
# Installs the pinned `didc`, the Candid tool `check_candid_compat.py` needs.
#
# `didc` is not on npm and `bootstrap_toolchain.sh` therefore cannot install it
# with the rest of the toolchain: it is a release asset from the `dfinity/candid`
# repository. The version is pinned here for the same reason every other tool in
# this kit is pinned — a compatibility gate that changes its mind between runs is
# not a gate.
#
# It goes next to the npm-installed tools, so `motoko_add_toolchain_to_path` from
# `toolchain_env.sh` finds it and nothing needs a writable /usr/local.
#
#   ./scripts/install_didc.sh          # install if missing
#   FORCE=1 ./scripts/install_didc.sh  # reinstall

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/toolchain_env.sh"

# Same release `apps/06_distributed_llm/tools/pocket-ic-setup.mjs` pins, so the
# replica harness and this gate cannot disagree about what `didc check` means.
release="${DIDC_RELEASE:-2024-07-29}"
version="0.4.0"

case "$(uname -s)" in
  Linux) asset="didc-linux64" ;;
  Darwin) asset="didc-macos" ;;
  *) echo "unsupported platform: $(uname -s); install didc manually and set DIDC" >&2; exit 1 ;;
esac

prefix="$(motoko_toolchain_prefix)"
target="$prefix/bin/didc"

if [[ -x "$target" && -z "${FORCE:-}" ]]; then
  echo "didc already installed: $target ($("$target" --version))"
  exit 0
fi

mkdir -p "$prefix/bin"
url="https://github.com/dfinity/candid/releases/download/$release/$asset"
echo "downloading $url"
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
curl -fsSL -m 120 -o "$temporary" "$url"
chmod +x "$temporary"

installed="$("$temporary" --version)"
if [[ "$installed" != "didc $version" ]]; then
  echo "expected 'didc $version', got '$installed'" >&2
  exit 1
fi

mv "$temporary" "$target"
trap - EXIT
echo "installed $installed at $target"
echo "add it to PATH with: export PATH=\"$prefix/bin:\$PATH\""
