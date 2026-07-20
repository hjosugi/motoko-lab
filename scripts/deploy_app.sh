#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 apps/01_creator_proof_registry" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="$root/$1"
if [[ ! -f "$app/icp.yaml" ]]; then
  echo "Not an app directory: $app" >&2
  exit 1
fi

command -v icp >/dev/null 2>&1 || { echo "Missing icp-cli." >&2; exit 1; }
command -v mops >/dev/null 2>&1 || { echo "Missing Mops." >&2; exit 1; }

cd "$app"
mops install
mops check
mops build
icp network start -d
icp deploy
