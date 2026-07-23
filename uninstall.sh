#!/bin/bash
set -euo pipefail
LABEL="com.john.orca-limit-watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "uninstalled: $LABEL (state left in ~/.local/state/orca-limit-watchdog)"
