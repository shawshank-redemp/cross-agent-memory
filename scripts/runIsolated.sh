#!/bin/sh
# Run a command against a disposable copy of the committed database, never the
# committed file itself.
#
# Why: openDb() runs CREATE TABLE IF NOT EXISTS on open, so even read-only
# analysis writes to the file it opens. Earlier, a verify run added an empty
# llm_call_metrics table to data/db/cross_agent_memory.sqlite, which then showed
# up as a modified tracked file.
#
# If CROSS_AGENT_MEMORY_DB_PATH is already set, the caller's choice is used and
# nothing is copied. Otherwise the committed database is copied to
# data/verify/verify.sqlite, which is disposable and gitignored.
#
# Usage: sh scripts/runIsolated.sh <command> [args...]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMMITTED="$ROOT/data/db/cross_agent_memory.sqlite"
SCRATCH_DIR="$ROOT/data/verify"
SCRATCH="$SCRATCH_DIR/verify.sqlite"

if [ -z "${CROSS_AGENT_MEMORY_DB_PATH:-}" ]; then
  mkdir -p "$SCRATCH_DIR"
  if [ -f "$COMMITTED" ]; then
    cp "$COMMITTED" "$SCRATCH"
  fi
  # A stale WAL from an earlier copy must not be replayed onto a fresh copy.
  rm -f "$SCRATCH-wal" "$SCRATCH-shm"
  export CROSS_AGENT_MEMORY_DB_PATH="$SCRATCH"
fi

# Refuse outright if the target is the committed file, whatever the caller set.
RESOLVED_TARGET=$(cd "$(dirname "$CROSS_AGENT_MEMORY_DB_PATH")" 2>/dev/null && pwd)/$(basename "$CROSS_AGENT_MEMORY_DB_PATH")
if [ "$RESOLVED_TARGET" = "$COMMITTED" ]; then
  echo "runIsolated: refusing to run against the committed database ($COMMITTED)." >&2
  exit 1
fi

exec "$@"
