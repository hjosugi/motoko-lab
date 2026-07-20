#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/toolchain_env.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi

packages=("@icp-sdk/icp-cli" "@icp-sdk/ic-wasm" "ic-mops")
global_prefix="$(npm prefix -g)"
install_prefix=""

if [[ -n "${MOTOKO_TOOLCHAIN_PREFIX:-}" ]]; then
  install_prefix="$(motoko_toolchain_prefix)"
elif [[ -d "$global_prefix" && -w "$global_prefix" ]]; then
  npm install -g "${packages[@]}"
else
  install_prefix="$(motoko_toolchain_prefix)"
fi

if [[ -n "$install_prefix" ]]; then
  echo "Global npm prefix is not writable; installing the toolchain under $install_prefix."
  npm install -g --prefix "$install_prefix" "${packages[@]}"
  export PATH="$install_prefix/bin:$PATH"
fi

icp --version
mops --version

echo "Toolchain installed. Each app pins moc in mops.toml; run ./scripts/check_all_apps.sh."
if [[ -n "$install_prefix" ]]; then
  echo "For direct CLI use in a new shell: export PATH=\"$install_prefix/bin:\$PATH\""
fi
