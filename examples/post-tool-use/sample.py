#!/usr/bin/env python3
"""Sample post-tool-use hook: logs received properties to OS temp dir sample.log."""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG = Path(os.environ.get("TMPDIR", "/tmp")) / "sample.log"


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with LOG.open("a") as f:
        f.write(f"--- post-tool-use {ts} ---\n")
        for k, v in payload.items():
            f.write(f"  {k}: {v}\n")
        f.write("\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
