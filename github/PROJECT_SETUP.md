# Project Setup

```bash
git init
git add .
git commit -m "chore: initialize Motoko mastery kit"

gh auth status
# Create or connect the target repository using your normal organization policy.

./scripts/create_labels.sh
./scripts/create_issues.sh
```

After reviewing dry-run output:

```bash
APPLY=1 TARGET_REPO=owner/repo ./scripts/create_labels.sh
APPLY=1 TARGET_REPO=owner/repo ./scripts/create_issues.sh
```

Do not open all 40 issues into an upstream Motoko repository. These issues are primarily for your application repository. Upstream issues must be individually reproduced and adapted to upstream contribution rules.
