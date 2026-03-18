#!/usr/bin/env bash
# Sample pre-tool-use hook: logs received properties to OS temp dir sample.log

set -e
LOG="${TMPDIR:-/tmp}/sample.log"
INPUT=$(cat)
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

{
  echo "--- pre-tool-use $TS ---"
  echo "$INPUT" | jq '.' 2>/dev/null || echo "  (raw) $INPUT"
  echo ""
} >> "$LOG"

exit 0
