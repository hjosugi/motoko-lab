#!/usr/bin/env bash
set -euo pipefail

for command in node npm; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing $command" >&2; exit 1; }
done

node --version
npm --version
npm view @icp-sdk/icp-cli version
npm view @icp-sdk/ic-wasm version
npm view ic-mops version

echo "Also verify Motoko Changelog and motoko-core README before changing pins."
