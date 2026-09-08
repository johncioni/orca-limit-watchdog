#!/bin/bash
# Install the orca-limit-watchdog LaunchAgent.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd -P)"
STATE="$HOME/.local/state/orca-limit-watchdog"
LABEL="com.john.orca-limit-watchdog"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "error: node not found in PATH" >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "error: node >= 20 required (found $NODE_MAJOR)" >&2; exit 1; }

# Substitute the plist placeholders with plain string replacement (no sed
# delimiter or backreference surprises when a path contains | & or \).
render_plist() {
  NODE_BIN="$NODE_BIN" REPO="$REPO" STATE="$STATE" python3 - "$1" "$2" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
for key, env in (("__NODE__", "NODE_BIN"), ("__REPO__", "REPO"), ("__STATE__", "STATE")):
    text = text.replace(key, os.environ[env])
open(dst, "w", encoding="utf-8").write(text)
PY
}

mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
render_plist "$REPO/$LABEL.plist" "$PLIST_DST"

launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "installed: $LABEL (every 5 min, node: $NODE_BIN)"
echo "disable anytime: touch $STATE/disabled"
