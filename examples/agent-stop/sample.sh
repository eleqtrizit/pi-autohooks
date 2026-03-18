#!/usr/bin/env bash
# Sample agent-stop hook: logs received properties to OS temp dir sample.log

set -e
LOG="${TMPDIR:-/tmp}/sample.log"
INPUT=$(cat)
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

{
  echo "--- agent-stop $TS ---"
  echo "$INPUT" | jq '.' 2>/dev/null || echo "  (raw) $INPUT"
  echo ""
} >> "$LOG"

exit 0
