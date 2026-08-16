#!/bin/bash
set -euo pipefail
# Publish openclaw-icloud-calendar to ClawHub (manual fallback; CI does this on v* tags).
# Usage: ./publish-clawhub.sh [--changelog "description of changes"]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION=$(node -p "require('$SCRIPT_DIR/package.json').version")
COMMIT=$(git -C "$SCRIPT_DIR" rev-parse HEAD)

CHANGELOG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --changelog) CHANGELOG="$2"; shift 2 ;;
    *) echo "Usage: $0 [--changelog \"description of changes\"]"; exit 1 ;;
  esac
done
if [[ -z "$CHANGELOG" ]]; then
  echo "Version: $VERSION"; echo "Commit:  $COMMIT"; read -rp "Changelog: " CHANGELOG
fi
[[ -n "$CHANGELOG" ]] || { echo "Error: changelog is required"; exit 1; }

"$SCRIPT_DIR/scripts/check-versions.sh"
echo "Publishing openclaw-icloud-calendar v$VERSION to ClawHub (commit $COMMIT)..."
(cd "$SCRIPT_DIR" && npm install && npm run build)

clawhub package publish "$SCRIPT_DIR" \
  --family code-plugin \
  --name "openclaw-icloud-calendar" \
  --display-name "iCloud Calendar" \
  --version "$VERSION" \
  --changelog "$CHANGELOG" \
  --tags "latest" \
  --source-repo "omarshahine/openclaw-icloud-calendar" \
  --source-commit "$COMMIT" \
  --source-ref "main"

echo "Published. Verify: clawhub package inspect openclaw-icloud-calendar"
