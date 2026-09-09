#!/bin/bash
# Install an archive release into stable, versioned user storage. Does not start it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
NODE_BIN="${ORCA_WATCHDOG_NODE:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || { echo "error: node not found; install Node 22 or 24, or set ORCA_WATCHDOG_NODE" >&2; exit 1; }

case "${1-}" in
  '') ACTION=install ;;
  --rollback) ACTION=rollback ;;
  *) echo "error: unknown argument: $1" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "error: unknown argument: $2" >&2; exit 2; }

exec "$NODE_BIN" "$ROOT/scripts/install-archive.mjs" "$ACTION"
