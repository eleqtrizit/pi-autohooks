# pi-autohooks

Run user-defined scripts at key lifecycle points in the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) loop. Any executable script — bash, Python, Ruby, Go binaries — can hook into tool calls before they run, after they return, or when the agent finishes a turn.

Uses the Claude Code-compatible JSON stdin/stdout protocol, so scripts written for Claude Code hooks work here without modification.

**Quick Links:** [Documentation](docs/) | [Examples](examples/) | [Events Reference](docs/events.md)

---

## Features

### Three hook stages

| Stage | Event | Fires | Use cases |
|-------|-------|-------|-----------|
| `pre-tool-use` | `tool_call` | Before a tool executes | Block dangerous commands, validate inputs, inject context |
| `post-tool-use` | `tool_result` | After a tool returns | Validate results, log output, inject follow-up context |
| `agent-stop` | `agent_end` | When the agent finishes a turn | Auto-run follow-up tasks, guard against incomplete work |

### Hook execution flow

```
User Request
    ↓
[pre-tool-use hooks] ← Can block tool execution
    ↓
Tool Executes
    ↓
[post-tool-use hooks] ← Can validate/modify results
    ↓
Agent Processes Result
    ↓
[agent-stop hooks] ← Can trigger follow-up actions
    ↓
Next Turn / Response
```

Post-tool and agent-stop feedback produced during one agent run is coalesced into
a single follow-up prompt. For example, ten edits that each produce hook feedback
result in one queued prompt containing all ten results, in execution order.

### Script discovery

- **Project-local**: `.pi/autohooks/<stage>/` — scoped to the current repo
- **Global fallback**: `~/.pi/agent/autohooks/<stage>/` — applies to all projects
- Project-local scripts **shadow** global ones by filename (no duplication)
- Scripts are discovered fresh on every event — add or remove scripts without restarting
- Only executable files are picked up, sorted alphabetically
- Supports any scripting language: bash, Python, Ruby, Go binaries, etc.

**Script execution order:**
1. All project-local scripts (alphabetically by filename)
2. All global scripts (alphabetically by filename)
3. Scripts run sequentially; each must complete before the next starts

### Communication protocol

Scripts receive JSON on **stdin** and communicate back via **stdout**, **stderr**, and **exit code**:

#### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — process normally, use stdout for context |
| `2` | Block/reject — use stderr as the rejection reason |
| `1` (or other) | Error — logged to console, execution continues |

#### JSON output fields

| Field | Stage | Purpose |
|-------|-------|---------|
| `hookSpecificOutput.additionalContext` | pre-tool-use | Context injected into the agent |
| `hookSpecificOutput.permissionDecision` | pre-tool-use | `"deny"` to block the tool call |
| `hookSpecificOutput.permissionDecisionReason` | pre-tool-use | Reason shown when blocking |
| `systemMessage` | post-tool-use | Message injected as system context |
| `decision` | post-tool-use/agent-stop | `"block"` to block/reject |
| `reason` | post-tool-use/agent-stop | Reason shown when blocking |

#### Output priority

1. **Exit 2** — Immediate block, stderr shown as reason
2. **JSON `permissionDecision: "deny"`** — Block with structured reason
3. **JSON `decision: "block"`** — Block/reject with reason
4. **stdout text/JSON** — Injected as context for the agent
5. **Raw text** — Sent directly to the agent as context

**Note:** Scripts have a **30-second timeout**. On timeout, the process receives `SIGTERM` then `SIGKILL` after 2 seconds.

### `/make-hook` command

An interactive command that guides the LLM to generate and install a hook script for you:

```bash
/make-hook validate that dangerous shell commands require confirmation
```

**What it does:**
1. Prompts for the hook scope (project or global)
2. Determines the appropriate hook stage(s) based on your description
3. Writes the script(s) to the correct directory
4. Makes them executable
5. Explains when each script will fire

**Example usage:**
```bash
# Log all tool calls
/make-hook log every tool call to /tmp/tool-calls.log

# Block destructive commands
/make-hook block any rm -rf commands that target system directories

# Auto-validate tests after writes
/make-hook run tests after any file write operation
```

### Timeout protection

Scripts have a **30-second execution limit**. On timeout:
1. Process receives `SIGTERM`
2. After 2 seconds, receives `SIGKILL`
3. Agent continues without hanging

### Infinite loop guard

The `agent-stop` input includes `stop_hook_active: true` when the agent was re-triggered by a previous stop hook. Use this flag to prevent runaway loops:

```bash
#!/usr/bin/env bash
INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')

if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  echo "Already triggered by stop hook this turn — skipping" >&2
  exit 0  # Don't block, just skip
fi

# Your hook logic here...
```

---

## Installation

### As a Pi package (recommended)

Add to your Pi `settings.json`:

```json
{
  "packages": [
    "git:github.com/mariozechner/pi-autohooks"
  ]
}
```

### Local development

**Option 1: Direct extension reference**
```json
{
  "extensions": [
    "/path/to/pi-autohooks/extensions/index.ts"
  ]
}
```

**Option 2: Copy to global extensions**
```bash
cp -r /path/to/pi-autohooks ~/.pi/agent/extensions/pi-autohooks
```

**Option 3: Copy to project**
```bash
cp -r /path/to/pi-autohooks .pi/extensions/pi-autohooks
```

### From source

```bash
git clone https://github.com/mariozechner/pi-autohooks
cd pi-autohooks
npm install
```

> **Security note:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

---

## Writing hook scripts

### File locations

| Scope | Base path | Example |
|-------|-----------|---------|
| Project | `<repo>/.pi/autohooks/<stage>/` | `.pi/autohooks/pre-tool-use/my-hook.sh` |
| Global | `~/.pi/agent/autohooks/<stage>/` | `~/.pi/agent/autohooks/pre-tool-use/my-hook.sh` |

**Important:**
- Scripts must be **executable** (`chmod +x`)
- Scripts are discovered **fresh on every event** — no restart needed
- Project scripts **shadow** global scripts with the same filename
- Scripts run **alphabetically** by filename

### Minimum viable hook (bash)

```bash
#!/usr/bin/env bash
set -e
INPUT=$(cat)          # JSON arrives on stdin
echo "$INPUT" | jq .  # do something with it
exit 0                # success
```

### Minimum viable hook (Python)

```python
#!/usr/bin/env python3
import json, sys

data = json.load(sys.stdin)
print(json.dumps({"hookSpecificOutput": {"additionalContext": "Hello from hook!"}}))
sys.exit(0)
```

### Output options

#### Allow and inject context

```bash
#!/usr/bin/env bash
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

if [[ "$TOOL" == "Write" ]]; then
  echo '{"hookSpecificOutput":{"additionalContext":"Remember: all new files need a license header."}}'
fi
exit 0
```

#### Block with exit code 2

```bash
#!/usr/bin/env bash
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

if [[ "$TOOL" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
  if echo "$COMMAND" | grep -qE 'rm\s+-rf\s+/'; then
    echo "Refusing rm -rf /" >&2
    exit 2
  fi
fi
exit 0
```

#### Block with JSON (pre-tool-use)

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

#### Block with JSON (post-tool-use / agent-stop)

```bash
#!/usr/bin/env bash
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

if [[ "$TOOL" == "Write" ]]; then
  # Check if file was written to a protected path
  FILE=$(echo "$INPUT" | jq -r '.tool_input.path // ""')
  if echo "$FILE" | grep -q "^/etc/"; then
    echo '{"decision":"block","reason":"Cannot write to /etc/"}'
    exit 0
  fi
fi
exit 0
```

---

## Input schema reference

### `pre-tool-use` (before tool executes)

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

**Available tools:** `Bash`, `Read`, `Write`, `Edit`, `Glob`, `LS`, `NotebookEdit`, etc.

### `post-tool-use` (after tool returns)

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

**Note:** `tool_response.content` format varies by tool:
- `Bash`: `{ "content": "...", "isError": false }`
- `Read`: `{ "content": "file contents", "isError": false }`
- `Write`: `{ "content": null, "isError": false }`

### `agent-stop` (when agent finishes a turn)

```jsonc
{
  "hook_event_name": "Stop",
  "session_id": "abc123",
  "cwd": "/home/user/project",
  "stop_hook_active": false
}
```

**Important:** `stop_hook_active: true` means the agent was already triggered by a stop hook this turn — use this to prevent infinite loops.

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

### Quick example: Block dangerous commands

**Create the hook:**
```bash
mkdir -p .pi/autohooks/pre-tool-use
cat > .pi/autohooks/pre-tool-use/block-dangerous.sh << 'EOF'
#!/usr/bin/env bash
set -e
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

if [[ "$TOOL" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
  # Block rm -rf on system directories
  if echo "$COMMAND" | grep -qE 'rm\s+-rf\s+/(bin|sbin|usr|etc|lib|var)'; then
    echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"Refusing to delete system files"}}'
    exit 0
  fi
fi
exit 0
EOF
chmod +x .pi/autohooks/pre-tool-use/block-dangerous.sh
```

### Quick example: Log all tool calls

**Create the hook:**
```bash
mkdir -p .pi/autohooks/pre-tool-use
cat > .pi/autohooks/pre-tool-use/log-calls.py << 'EOF'
#!/usr/bin/env python3
import json, sys, os
from datetime import datetime

log_file = os.path.join(os.getenv('TMPDIR', '/tmp'), 'pi-hooks.log')
data = json.load(sys.stdin)

with open(log_file, 'a') as f:
    f.write(f"\n{datetime.utcnow().isoformat()}Z\n")
    f.write(json.dumps(data, indent=2) + "\n")

sys.exit(0)
EOF
chmod +x .pi/autohooks/pre-tool-use/log-calls.py
```

---

## Development

### Setup

```bash
git clone https://github.com/mariozechner/pi-autohooks
cd pi-autohooks
npm install
```

### Testing

```bash
npm test
```

### Debugging hooks

To debug your hook scripts:

```bash
# Add logging to see what's being passed
echo "DEBUG: $(cat)" >> /tmp/hook-debug.log

# Test a script manually
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./my-hook.sh
```

### Package structure

```
pi-autohooks/
├── extensions/
│   └── index.ts          # Extension entry point
├── src/
│   └── hooks-runner.ts   # Core hook execution logic
├── examples/
│   ├── pre-tool-use/
│   ├── post-tool-use/
│   └── agent-stop/
├── docs/                 # Extension documentation
└── package.json
```

### Available npm packages in hooks

Hooks can use any npm package available in the Pi environment. Common packages include:
- Standard Node.js modules: `fs`, `path`, `child_process`, etc.
- JSON parsing: Built-in `JSON.parse()` / `JSON.stringify()`
- For complex logic, use Python/bash with standard libraries

---

## Troubleshooting

### Script not running

1. **Check it's executable:** `chmod +x my-hook.sh`
2. **Check the path:** Scripts must be in `.pi/autohooks/<stage>/`
3. **Check the event:** Make sure you're using the right stage for your use case
4. **Check logs:** Look for errors in the Pi console

### Script errors

- Exit code `1` (or other non-0/2): Logged to console, execution continues
- Exit code `2`: Blocks the action, stderr shown as reason
- Exit code `0`: Success, stdout used for context

### Timeout

If your script takes longer than 30 seconds, it will be terminated. Optimize your script or split into smaller hooks.

---

## License

MIT
