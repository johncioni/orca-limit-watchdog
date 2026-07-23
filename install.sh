#!/bin/bash
# Install the orca-limit-watchdog LaunchAgent.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
STATE="$HOME/.local/state/orca-limit-watchdog"
LABEL="com.john.orca-limit-watchdog"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "error: node not found in PATH" >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "error: node >= 20 required (found $NODE_MAJOR)" >&2; exit 1; }

mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__REPO__|$REPO|g" -e "s|__STATE__|$STATE|g" \
  "$REPO/$LABEL.plist" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "installed: $LABEL (every 5 min, node: $NODE_BIN)"
echo "disable anytime: touch $STATE/disabled"
