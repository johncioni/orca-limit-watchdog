#!/usr/bin/env bash
# Orca per-worktree setup hook for orca-limit-watchdog.
#
# Runs on `orca worktree create` (repo hookSettings: setupRunPolicy=run-by-default,
# setupAgentStartupPolicy=wait-for-setup), so a spawned agent blocks until this
# finishes. Point the repo's Orca setup script at this file (Orca app → repo
# settings: `bash scripts/orca-setup.sh`) so the command is versioned here
# instead of living only in local Orca config.
#
# The daemon has zero dependencies (plain system Node, no package.json), so
# there is nothing to install. This is a verification warm-up: a fresh worktree
# proves it can run the full local gate before an agent touches it.
#
# Idempotent, offline, and safe to run by hand. It NEVER touches
# ~/Library/LaunchAgents or ~/.local/state/orca-limit-watchdog: deploying the
# live LaunchAgent is install.sh, run post-merge from the main checkout only.
set -euo pipefail
cd "$(dirname "$0")/.."

# Same floor install.sh enforces, so a worktree that passes here can be deployed.
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "error: node not found in PATH" >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "error: node >= 20 required (found $NODE_MAJOR)" >&2; exit 1; }

echo "==> syntax: watchdog.mjs, install.sh, uninstall.sh, scripts/orca-setup.sh"
node --check watchdog.mjs
bash -n install.sh uninstall.sh scripts/orca-setup.sh

echo "==> node --test"
node --test

echo "==> Worktree ready."
echo "  node:   $("$NODE_BIN" --version)"
echo "  tests:  passed"
echo "  NOTE:   do NOT run install.sh from this worktree; deploy from the main"
echo "          checkout after merge (CLAUDE.md → Safety)."
