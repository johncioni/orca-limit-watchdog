#!/bin/bash
set -euo pipefail

[ "$#" -eq 0 ] || { echo "error: unknown argument: $1" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
NODE_BIN="${ORCA_WATCHDOG_NODE:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || { echo "error: node not found; install Node 22 or 24, or set ORCA_WATCHDOG_NODE" >&2; exit 1; }
exec "$NODE_BIN" "$ROOT/scripts/uninstall-archive.mjs"
