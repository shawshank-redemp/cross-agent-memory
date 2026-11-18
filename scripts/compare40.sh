#!/bin/sh
# Three arms (agentic, baseline, memory) on about 40 cart events spanning the
# labelled scenarios, on a FRESH isolated database.
#
#   PLAN=1 sh scripts/compare40.sh     selection and call estimate only; no model calls
#   sh scripts/compare40.sh            the real run (local Ollama only)
#
# The fresh database is data/compare40/compare40.sqlite. It is deleted and
# rebuilt from the committed batch on every run, so no earlier failed rows or
# decisions can reach the metrics. The committed database is never opened.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="$ROOT/data/compare40"
DB="$DIR/compare40.sqlite"
N="${N:-40}"

: "${OLLAMA_MODEL:=qwen2.5:7b}"
export OLLAMA_MODEL
export LLM_PROVIDER=ollama

mkdir -p "$DIR"
rm -f "$DB" "$DB-wal" "$DB-shm"

echo "fresh database: $DB"
CROSS_AGENT_MEMORY_DB_PATH="$DB" npm run --silent load:data > /dev/null

if [ "${PLAN:-0}" = "1" ]; then
  CROSS_AGENT_MEMORY_DB_PATH="$DB" npx tsx src/agentic/run.ts --stratified --limit="$N" --compare --plan
  exit 0
fi

CROSS_AGENT_MEMORY_DB_PATH="$DB" npx tsx src/agentic/run.ts --stratified --limit="$N" --compare
echo ""
CROSS_AGENT_MEMORY_DB_PATH="$DB" npm run --silent analyze:arms
echo ""
CROSS_AGENT_MEMORY_DB_PATH="$DB" npm run --silent analyze:metrics
