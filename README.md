# pi-autohooks

Run user-defined scripts at key lifecycle points in the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) loop. Any executable script — bash, Python, Ruby, Go binaries — can hook into tool calls before they run, after they return, or when the agent finishes a turn.

Uses the Claude Code-compatible JSON stdin/stdout protocol, so scripts written for Claude Code hooks work here without modification.

---

## Features

### Three hook stages

| Stage | Fires | Use cases |
|-------|-------|-----------|
| `pre-tool-use` | Before a tool executes | Block dangerous commands, validate inputs, inject context |
| `post-tool-use` | After a tool returns | Validate results, log output, inject follow-up context |
| `agent-stop` | When the agent finishes a turn | Auto-run follow-up tasks, guard against incomplete work |

### Script discovery

- **Project-local**: `.pi/autohooks/<stage>/` — scoped to the current repo
- **Global fallback**: `~/.pi/agent/autohooks/<stage>/` — applies to all projects
- Project-local scripts **shadow** global ones by filename (no duplication)
- Scripts are discovered fresh on every event — add or remove scripts without restarting
- Only executable files are picked up, sorted alphabetically

### Communication protocol

Scripts receive JSON on **stdin** and communicate back via **stdout** and **exit code**:

```
exit 0   → success (stdout returned to agent as context)
exit 2   → block the action (stderr used as reason)
```

JSON output fields understood:

| Field | Purpose |
|-------|---------|
| `hookSpecificOutput.additionalContext` | Context injected into the agent |
| `hookSpecificOutput.permissionDecision` | `"deny"` to block (pre-tool-use) |
| `hookSpecificOutput.permissionDecisionReason` | Reason shown when blocking |
| `systemMessage` | Message injected as system context |
| `decision` | `"block"` to block (post-tool-use / stop) |
| `reason` | Reason shown when blocking |

Raw text output (non-JSON) is sent directly to the agent as context.

### `/make-hook` command

An interactive command that guides the LLM to generate and install a hook script for you:

```
/make-hook validate that dangerous shell commands require confirmation
```

Prompts for scope (project or global) and writes the script to the right directory.

### Timeout protection

Scripts have a 30-second execution limit. On timeout, the process receives `SIGTERM` then `SIGKILL` after 2 seconds — the agent is never left hanging.

### Infinite loop guard

The `agent-stop` input includes `stop_hook_active: true` when the agent was re-triggered by a previous stop hook. Use this flag to prevent runaway loops.

---

## Installation

### As a Pi package (recommended)

Add to your Pi `settings.json`:

```json
{
  "packages": [
    "git:github.com/YOUR_USERNAME/pi-autohooks"
  ]
}
```

Or reference it locally:

```json
{
  "extensions": [
    "/path/to/pi-autohooks/extensions/index.ts"
  ]
}
```

### Global extension

Copy or symlink the extension into Pi's global extensions directory:

```bash
cp -r /path/to/pi-autohooks ~/.pi/agent/extensions/pi-autohooks
```

### Project-local extension

```bash
cp -r /path/to/pi-autohooks .pi/extensions/pi-autohooks
```

### From source

```bash
git clone https://github.com/YOUR_USERNAME/pi-autohooks
cd pi-autohooks
npm install
```

> **Security note:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

---

## Writing hook scripts

### Minimum viable hook (bash)

```bash
#!/usr/bin/env bash
set -e
INPUT=$(cat)          # JSON arrives on stdin
echo "$INPUT" | jq .  # do something with it
exit 0                # success
```

### Block a tool call

```bash
#!/usr/bin/env bash
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

if [[ "$TOOL" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
  if echo "$COMMAND" | grep -qE 'rm\s+-rf\s+/'; then
    echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"Refusing rm -rf /"}}'
    exit 0
  fi
fi

exit 0
```

### Inject context (Python)

```python
#!/usr/bin/env python3
import json, sys

data = json.load(sys.stdin)
tool = data.get("tool_name", "")

if tool == "Write":
    print(json.dumps({
        "hookSpecificOutput": {
            "additionalContext": "Remember: all new files need a licence header."
        }
    }))

sys.exit(0)
```

### Install a hook

```bash
# Project-local
mkdir -p .pi/autohooks/pre-tool-use
cp my-validator.sh .pi/autohooks/pre-tool-use/
chmod +x .pi/autohooks/pre-tool-use/my-validator.sh

# Global
mkdir -p ~/.pi/agent/autohooks/pre-tool-use
cp my-validator.sh ~/.pi/agent/autohooks/pre-tool-use/
chmod +x ~/.pi/agent/autohooks/pre-tool-use/my-validator.sh
```

---

## Input schema reference

### `pre-tool-use`

```jsonc
{
  "hook_event_name": "PreToolUse",
  "session_id": "abc123",
  "cwd": "/home/user/project",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01...",
  "tool_input": { "command": "ls -la" }
}
```

### `post-tool-use`

```jsonc
{
  "hook_event_name": "PostToolUse",
  "session_id": "abc123",
  "cwd": "/home/user/project",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01...",
  "tool_input": { "command": "ls -la" },
  "tool_response": { "content": "...", "isError": false }
}
```

### `agent-stop`

```jsonc
{
  "hook_event_name": "Stop",
  "session_id": "abc123",
  "cwd": "/home/user/project",
  "stop_hook_active": false
}
```

---

## Example hooks

Ready-to-use sample scripts are in [`examples/`](examples/):

```
examples/
├── pre-tool-use/
│   ├── sample.sh    # Logs every tool call to /tmp/sample.log
│   └── sample.py
├── post-tool-use/
│   ├── sample.sh    # Logs every tool result to /tmp/sample.log
│   └── sample.py
└── agent-stop/
    ├── sample.sh    # Logs every agent stop to /tmp/sample.log
    └── sample.py
```

---

## Development

```bash
npm install
npm test
```

---

## License

MIT
