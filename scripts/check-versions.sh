#!/usr/bin/env bash
# Verify that all plugin version sources agree. Exits non-zero if any disagree.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)" >&2; exit 2; }
v_pkg=$(jq -r '.version' package.json)
v_mkt=$(jq -r '.plugins[0].version' marketplace.json)
v_man=$(jq -r '.version' openclaw.plugin.json)
printf "%-24s %s\n" "package.json" "$v_pkg" "marketplace.json" "$v_mkt" "openclaw.plugin.json" "$v_man"
if [ "$(printf '%s\n' "$v_pkg" "$v_mkt" "$v_man" | sort -u | wc -l | tr -d ' ')" != "1" ]; then
  echo "FAIL: version sources disagree." >&2; exit 1
fi
echo "OK: all version sources agree on $v_pkg"
