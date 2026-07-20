#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

args=(--dir github/issues)
if [[ "${APPLY:-0}" == "1" ]]; then
  : "${TARGET_REPO:?Set TARGET_REPO=owner/repo when APPLY=1}"
  command -v gh >/dev/null 2>&1 || { echo "GitHub CLI gh is required." >&2; exit 1; }
  gh auth status
  args+=(--apply --repo "$TARGET_REPO")
  if [[ "${USE_MILESTONES:-0}" == "1" ]]; then
    args+=(--use-milestones)
  fi
else
  echo "Dry run only. Set APPLY=1 TARGET_REPO=owner/repo after review." >&2
fi

python3 scripts/issue_loader.py "${args[@]}"
