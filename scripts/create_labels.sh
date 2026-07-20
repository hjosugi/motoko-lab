#!/usr/bin/env bash
set -euo pipefail

if [[ "${APPLY:-0}" == "1" ]]; then
  : "${TARGET_REPO:?Set TARGET_REPO=owner/repo when APPLY=1}"
  command -v gh >/dev/null 2>&1 || { echo "GitHub CLI gh is required." >&2; exit 1; }
  gh auth status
else
  echo "Dry run only. Set APPLY=1 TARGET_REPO=owner/repo after review." >&2
fi

# Use a visible placeholder in dry-run mode while preserving strict APPLY=1 validation.
TARGET_REPO="${TARGET_REPO:-OWNER/REPO}"

echo "gh label create \"priority:P0\" --repo \"$TARGET_REPO\" --description \"Launch/security blocker\" --color \"b60205\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "priority:P0" --repo "$TARGET_REPO" --description "Launch/security blocker" --color "b60205" --force; fi
echo "gh label create \"priority:P1\" --repo \"$TARGET_REPO\" --description \"Important planned work\" --color \"d93f0b\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "priority:P1" --repo "$TARGET_REPO" --description "Important planned work" --color "d93f0b" --force; fi
echo "gh label create \"priority:P2\" --repo \"$TARGET_REPO\" --description \"Useful non-blocking work\" --color \"fbca04\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "priority:P2" --repo "$TARGET_REPO" --description "Useful non-blocking work" --color "fbca04" --force; fi
echo "gh label create \"type:security\" --repo \"$TARGET_REPO\" --description \"Security hardening or review\" --color \"8b0000\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "type:security" --repo "$TARGET_REPO" --description "Security hardening or review" --color "8b0000" --force; fi
echo "gh label create \"type:feature\" --repo \"$TARGET_REPO\" --description \"New behavior\" --color \"1d76db\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "type:feature" --repo "$TARGET_REPO" --description "New behavior" --color "1d76db" --force; fi
echo "gh label create \"type:research\" --repo \"$TARGET_REPO\" --description \"Time-boxed investigation\" --color \"5319e7\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "type:research" --repo "$TARGET_REPO" --description "Time-boxed investigation" --color "5319e7" --force; fi
echo "gh label create \"type:docs\" --repo \"$TARGET_REPO\" --description \"Documentation\" --color \"0075ca\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "type:docs" --repo "$TARGET_REPO" --description "Documentation" --color "0075ca" --force; fi
echo "gh label create \"type:chore\" --repo \"$TARGET_REPO\" --description \"Maintenance\" --color \"cfd3d7\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "type:chore" --repo "$TARGET_REPO" --description "Maintenance" --color "cfd3d7" --force; fi
echo "gh label create \"type:bug\" --repo \"$TARGET_REPO\" --description \"Confirmed defect\" --color \"d73a4a\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "type:bug" --repo "$TARGET_REPO" --description "Confirmed defect" --color "d73a4a" --force; fi
echo "gh label create \"effort:S\" --repo \"$TARGET_REPO\" --description \"Small effort\" --color \"c2e0c6\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "effort:S" --repo "$TARGET_REPO" --description "Small effort" --color "c2e0c6" --force; fi
echo "gh label create \"effort:M\" --repo \"$TARGET_REPO\" --description \"Medium effort\" --color \"bfdadc\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "effort:M" --repo "$TARGET_REPO" --description "Medium effort" --color "bfdadc" --force; fi
echo "gh label create \"effort:L\" --repo \"$TARGET_REPO\" --description \"Large effort\" --color \"fef2c0\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "effort:L" --repo "$TARGET_REPO" --description "Large effort" --color "fef2c0" --force; fi
echo "gh label create \"effort:XL\" --repo \"$TARGET_REPO\" --description \"Extra-large effort\" --color \"f9d0c4\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "effort:XL" --repo "$TARGET_REPO" --description "Extra-large effort" --color "f9d0c4" --force; fi
echo "gh label create \"area:ai\" --repo \"$TARGET_REPO\" --description \"Work in ai\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:ai" --repo "$TARGET_REPO" --description "Work in ai" --color "d4c5f9" --force; fi
echo "gh label create \"area:api\" --repo \"$TARGET_REPO\" --description \"Work in api\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:api" --repo "$TARGET_REPO" --description "Work in api" --color "d4c5f9" --force; fi
echo "gh label create \"area:build\" --repo \"$TARGET_REPO\" --description \"Work in build\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:build" --repo "$TARGET_REPO" --description "Work in build" --color "d4c5f9" --force; fi
echo "gh label create \"area:business\" --repo \"$TARGET_REPO\" --description \"Work in business\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:business" --repo "$TARGET_REPO" --description "Work in business" --color "d4c5f9" --force; fi
echo "gh label create \"area:community\" --repo \"$TARGET_REPO\" --description \"Work in community\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:community" --repo "$TARGET_REPO" --description "Work in community" --color "d4c5f9" --force; fi
echo "gh label create \"area:compiler\" --repo \"$TARGET_REPO\" --description \"Work in compiler\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:compiler" --repo "$TARGET_REPO" --description "Work in compiler" --color "d4c5f9" --force; fi
echo "gh label create \"area:core\" --repo \"$TARGET_REPO\" --description \"Work in core\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:core" --repo "$TARGET_REPO" --description "Work in core" --color "d4c5f9" --force; fi
echo "gh label create \"area:crypto\" --repo \"$TARGET_REPO\" --description \"Work in crypto\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:crypto" --repo "$TARGET_REPO" --description "Work in crypto" --color "d4c5f9" --force; fi
echo "gh label create \"area:developer-experience\" --repo \"$TARGET_REPO\" --description \"Work in developer-experience\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:developer-experience" --repo "$TARGET_REPO" --description "Work in developer-experience" --color "d4c5f9" --force; fi
echo "gh label create \"area:docs\" --repo \"$TARGET_REPO\" --description \"Work in docs\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:docs" --repo "$TARGET_REPO" --description "Work in docs" --color "d4c5f9" --force; fi
echo "gh label create \"area:frontend\" --repo \"$TARGET_REPO\" --description \"Work in frontend\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:frontend" --repo "$TARGET_REPO" --description "Work in frontend" --color "d4c5f9" --force; fi
echo "gh label create \"area:governance\" --repo \"$TARGET_REPO\" --description \"Work in governance\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:governance" --repo "$TARGET_REPO" --description "Work in governance" --color "d4c5f9" --force; fi
echo "gh label create \"area:identity\" --repo \"$TARGET_REPO\" --description \"Work in identity\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:identity" --repo "$TARGET_REPO" --description "Work in identity" --color "d4c5f9" --force; fi
echo "gh label create \"area:interop\" --repo \"$TARGET_REPO\" --description \"Work in interop\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:interop" --repo "$TARGET_REPO" --description "Work in interop" --color "d4c5f9" --force; fi
echo "gh label create \"area:legal\" --repo \"$TARGET_REPO\" --description \"Work in legal\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:legal" --repo "$TARGET_REPO" --description "Work in legal" --color "d4c5f9" --force; fi
echo "gh label create \"area:operations\" --repo \"$TARGET_REPO\" --description \"Work in operations\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:operations" --repo "$TARGET_REPO" --description "Work in operations" --color "d4c5f9" --force; fi
echo "gh label create \"area:payments\" --repo \"$TARGET_REPO\" --description \"Work in payments\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:payments" --repo "$TARGET_REPO" --description "Work in payments" --color "d4c5f9" --force; fi
echo "gh label create \"area:performance\" --repo \"$TARGET_REPO\" --description \"Work in performance\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:performance" --repo "$TARGET_REPO" --description "Work in performance" --color "d4c5f9" --force; fi
echo "gh label create \"area:privacy\" --repo \"$TARGET_REPO\" --description \"Work in privacy\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:privacy" --repo "$TARGET_REPO" --description "Work in privacy" --color "d4c5f9" --force; fi
echo "gh label create \"area:provenance\" --repo \"$TARGET_REPO\" --description \"Work in provenance\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:provenance" --repo "$TARGET_REPO" --description "Work in provenance" --color "d4c5f9" --force; fi
echo "gh label create \"area:release\" --repo \"$TARGET_REPO\" --description \"Work in release\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:release" --repo "$TARGET_REPO" --description "Work in release" --color "d4c5f9" --force; fi
echo "gh label create \"area:scale\" --repo \"$TARGET_REPO\" --description \"Work in scale\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:scale" --repo "$TARGET_REPO" --description "Work in scale" --color "d4c5f9" --force; fi
echo "gh label create \"area:security\" --repo \"$TARGET_REPO\" --description \"Work in security\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:security" --repo "$TARGET_REPO" --description "Work in security" --color "d4c5f9" --force; fi
echo "gh label create \"area:storage\" --repo \"$TARGET_REPO\" --description \"Work in storage\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:storage" --repo "$TARGET_REPO" --description "Work in storage" --color "d4c5f9" --force; fi
echo "gh label create \"area:supply-chain\" --repo \"$TARGET_REPO\" --description \"Work in supply-chain\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:supply-chain" --repo "$TARGET_REPO" --description "Work in supply-chain" --color "d4c5f9" --force; fi
echo "gh label create \"area:test\" --repo \"$TARGET_REPO\" --description \"Work in test\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:test" --repo "$TARGET_REPO" --description "Work in test" --color "d4c5f9" --force; fi
echo "gh label create \"area:upgrade\" --repo \"$TARGET_REPO\" --description \"Work in upgrade\" --color \"d4c5f9\" --force"
if [[ "${APPLY:-0}" == "1" ]]; then gh label create "area:upgrade" --repo "$TARGET_REPO" --description "Work in upgrade" --color "d4c5f9" --force; fi
