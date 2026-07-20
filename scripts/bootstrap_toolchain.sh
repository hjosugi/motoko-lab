#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi

npm install -g @icp-sdk/icp-cli @icp-sdk/ic-wasm
npm install -g ic-mops

icp --version
mops --version

echo "Toolchain installed. Each app pins moc in mops.toml; run mops install in the app directory."
