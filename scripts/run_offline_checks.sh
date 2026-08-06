#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATION_DIR="$ROOT/validation"
LOG="$VALIDATION_DIR/execution-tests.txt"
mkdir -p "$VALIDATION_DIR"

exec > >(tee "$LOG") 2>&1

echo "Motoko Mastery Kit offline execution checks"
echo "Snapshot: 2026-07-20 JST"
echo "Root: $ROOT"
echo

run() {
  echo "+ $*"
  "$@"
  echo
}

echo "[1/8] Shell syntax"
for script in "$ROOT"/scripts/*.sh; do
  run bash -n "$script"
done

echo "[2/8] Python source compilation without bytecode output"
ROOT_FOR_PY="$ROOT" python3 - <<'PY'
import os
from pathlib import Path
root = Path(os.environ["ROOT_FOR_PY"])
files = sorted((root / "scripts").glob("*.py"))
for path in files:
    compile(path.read_text(encoding="utf-8"), str(path), "exec")
    print(f"ok: {path.relative_to(root)}")
print(f"compiled: {len(files)} Python files")
PY
echo

echo "[3/8] Node syntax"
for module in "$ROOT"/protocol/tools/*.mjs; do
  run node --check "$module"
done

echo "[4/8] Provenance protocol tests"
run node "$ROOT/protocol/tools/provenance-cli.test.mjs"

echo "[5/8] Motoko/Candid API surface"
run python3 "$ROOT/scripts/check_api_surface.py" "$ROOT" \
  --json-report "$VALIDATION_DIR/api-surface.json" \
  --markdown-report "$VALIDATION_DIR/API_SURFACE.md"

echo "[6/8] GitHub automation dry-runs"
labels_output="$(mktemp)"
issues_output="$(mktemp)"
trap 'rm -f "$labels_output" "$issues_output"' EXIT
"$ROOT/scripts/create_labels.sh" >"$labels_output"
echo "label commands: $(grep -c '^gh label create' "$labels_output")"
"$ROOT/scripts/create_issues.sh" >"$issues_output"
echo "issue dry-run output lines: $(wc -l < "$issues_output" | tr -d ' ')"
echo

echo "[7/8] Structural validation"
run python3 "$ROOT/scripts/validate_kit.py" "$ROOT" \
  --json-report "$VALIDATION_DIR/structural-validation.json"

echo "[8/8] Workspace hygiene"
find "$ROOT" -type d -name __pycache__ -prune -exec rm -rf {} +

# What matters is that no generated directory can be packaged, not that none
# exists on disk. `apps/06_distributed_llm/tools` legitimately holds an npm tree
# and a downloaded replica after its harness has been run, and both are ignored.
# So: a generated directory is acceptable exactly when git ignores it. Without
# git (a ZIP distribution, say) fall back to requiring that none exist at all.
unexpected=0
while IFS= read -r directory; do
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    if git -C "$ROOT" check-ignore -q "$directory"; then
      echo "ignored, not packaged: ${directory#"$ROOT/"}"
      continue
    fi
  fi
  echo "generated directory is not ignored and would be packaged: ${directory#"$ROOT/"}" >&2
  unexpected=1
done < <(find "$ROOT" -type d \( -name node_modules -o -name .mops -o -name .mops-cache -o -name .pocket-ic -o -name __pycache__ -o -name site -o -name site-src -o -name .venv-docs -o -path '*/.icp/cache' \) -prune -print)

if (( unexpected )); then
  exit 1
fi
echo "No generated dependency or cache directory can reach the package."
echo
echo "OFFLINE CHECKS: PASS"
