/**
 * Hooks Runner Extension
 *
 * Runs user-defined scripts at key lifecycle points in the agent loop,
 * using a Claude Code-compatible JSON stdin/stdout protocol.
 *
 * Hook directories (scripts discovered fresh on each event, no caching):
 *   <repo>/.pi/autohooks/pre-tool-use/   — project-local (wins on name collision)
 *   <repo>/.pi/autohooks/post-tool-use/
 *   <repo>/.pi/autohooks/agent-stop/
 *   ~/.pi/agent/autohooks/pre-tool-use/  — global fallback
 *   ~/.pi/agent/autohooks/post-tool-use/
 *   ~/.pi/agent/autohooks/agent-stop/
 *
 * Scripts must be executable. Input arrives as JSON on stdin.
 * Non-empty output is sent back to the agent as a prompt.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptResult {
	stdout: string;
	stderr: string;
	code: number;
}

interface PreToolUseInput {
	session_id: string;
	cwd: string;
	hook_event_name: "PreToolUse";
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id: string;
}

interface PostToolUseInput {
	session_id: string;
	cwd: string;
	hook_event_name: "PostToolUse";
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_response: { content: unknown; isError: boolean };
	tool_use_id: string;
}

interface StopInput {
	session_id: string;
	cwd: string;
	hook_event_name: "Stop";
	stop_hook_active: boolean;
}

// ---------------------------------------------------------------------------
// Script discovery
// ---------------------------------------------------------------------------

/**
 * Returns the ordered list of executable scripts to run for a hook event.
 * Project-local scripts take precedence over global ones: if a filename
 * exists in both directories, only the local version is returned.
 *
 * @param hookDir - Subdirectory name, e.g. "pre-tool-use"
 * @param cwd - Current working directory (project root)
 * @returns Absolute paths of scripts to execute, in sorted order
 */
function getHookScripts(hookDir: string, cwd: string): string[] {
	const localDir = join(cwd, ".pi", "autohooks", hookDir);
	const globalDir = join(homedir(), ".pi", "agent", "autohooks", hookDir);

	const seen = new Set<string>();
	const scripts: string[] = [];

	const addFrom = (dir: string, localOnly: boolean) => {
		if (!existsSync(dir)) return;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const file of entries) {
			if (localOnly || !seen.has(file)) {
				const fullPath = join(dir, file);
				try {
					const stat = statSync(fullPath);
					if (!stat.isFile()) continue;
					// Skip non-executable files
					const { mode } = stat;
					const isExecutable = !!(mode & 0o111);
					if (!isExecutable) continue;
				} catch {
					continue;
				}
				seen.add(file);
				scripts.push(fullPath);
			}
		}
	};

	addFrom(localDir, true);
	addFrom(globalDir, false);

	return scripts;
}

// ---------------------------------------------------------------------------
// Script runner
// ---------------------------------------------------------------------------

const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Runs a single hook script, passing JSON input via stdin.
 *
 * @param scriptPath - Absolute path to the executable script
 * @param input - JSON-serializable object written to the script's stdin
 * @returns stdout, stderr, and exit code from the process
 */
function runScript(scriptPath: string, input: unknown): Promise<ScriptResult> {
	return new Promise((resolve) => {
		const proc = spawn(scriptPath, [], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 2000);
			resolve({ stdout, stderr: stderr + "\n[hook timed out]", code: 1 });
		}, SCRIPT_TIMEOUT_MS);

		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 1 });
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({ stdout: "", stderr: err.message, code: 1 });
		});

		try {
			proc.stdin.write(JSON.stringify(input));
			proc.stdin.end();
		} catch {
			// stdin may already be closed
		}
	});
}

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

/**
 * Extracts human-readable text from a script's stdout.
 * Understands Claude Code JSON output fields; falls back to raw text.
 *
 * @param raw - Raw stdout string from the script
 * @returns Trimmed text, or empty string if nothing useful was found
 */
function extractText(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";

	try {
		const parsed = JSON.parse(trimmed);

		// Claude Code: hookSpecificOutput.additionalContext
		const additional = parsed?.hookSpecificOutput?.additionalContext;
		if (typeof additional === "string" && additional.trim()) return additional.trim();

		// Claude Code: top-level systemMessage
		const sysMsg = parsed?.systemMessage;
		if (typeof sysMsg === "string" && sysMsg.trim()) return sysMsg.trim();

		// Claude Code: top-level reason (used in deny decisions)
		const reason = parsed?.reason;
		if (typeof reason === "string" && reason.trim()) return reason.trim();

		return "";
	} catch {
		return trimmed;
	}
}

/**
 * Checks whether a script result signals a deny/block decision.
 * Supports both Claude Code's permissionDecision and top-level decision fields.
 *
 * @param result - Script execution result
 * @returns Block reason string if blocked, null otherwise
 */
function getBlockReason(result: ScriptResult): string | null {
	// Exit 2 = explicit block via stderr
	if (result.code === 2) {
		return result.stderr.trim() || "Blocked by hook";
	}

	if (result.code === 0 && result.stdout.trim()) {
		try {
			const parsed = JSON.parse(result.stdout.trim());

			// Claude Code PreToolUse: hookSpecificOutput.permissionDecision === "deny"
			if (parsed?.hookSpecificOutput?.permissionDecision === "deny") {
				return (
					parsed.hookSpecificOutput.permissionDecisionReason?.trim() || "Blocked by hook"
				);
			}

			// Claude Code PostToolUse / Stop: top-level decision === "block"
			if (parsed?.decision === "block") {
				return parsed.reason?.trim() || "Blocked by hook";
			}

			// Legacy Claude Code: decision === "approve"/"block" (deprecated alias)
			if (parsed?.hookSpecificOutput?.permissionDecision === "block") {
				return (
					parsed.hookSpecificOutput.permissionDecisionReason?.trim() || "Blocked by hook"
				);
			}
		} catch {
			// not JSON — not a block signal
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Hook recipes (static reference data for the /make-hook prompt)
// ---------------------------------------------------------------------------

const HOOK_RECIPES = `
## Hook Types Reference

Scripts must be executable (\`chmod +x\`). Input is JSON on stdin. Output protocol below.

---

### 1. pre-tool-use  (fires BEFORE a tool runs)

**JSON stdin:**
\`\`\`json
{
  "session_id": "string",
  "cwd": "string",
  "hook_event_name": "PreToolUse",
  "tool_name": "string",
  "tool_input": { ... },
  "tool_use_id": "string"
}
\`\`\`

**To BLOCK the tool** (exit 2, message on stderr):
\`\`\`bash
echo "reason" >&2; exit 2
\`\`\`

**To BLOCK via JSON** (exit 0):
\`\`\`json
{ "hookSpecificOutput": { "permissionDecision": "deny", "permissionDecisionReason": "reason" } }
\`\`\`

**To ADD CONTEXT** for the LLM (exit 0, text/JSON on stdout):
\`\`\`json
{ "hookSpecificOutput": { "additionalContext": "useful info for the LLM" } }
\`\`\`

---

### 2. post-tool-use  (fires AFTER a tool returns)

**JSON stdin:**
\`\`\`json
{
  "session_id": "string",
  "cwd": "string",
  "hook_event_name": "PostToolUse",
  "tool_name": "string",
  "tool_input": { ... },
  "tool_response": { "content": ..., "isError": false },
  "tool_use_id": "string"
}
\`\`\`

**To BLOCK / send follow-up message** (exit 2, message on stderr):
\`\`\`bash
echo "reason" >&2; exit 2
\`\`\`

**To BLOCK via JSON** (exit 0):
\`\`\`json
{ "decision": "block", "reason": "reason" }
\`\`\`

**To inject context** (exit 0, text/JSON on stdout):
\`\`\`json
{ "systemMessage": "context for the LLM" }
\`\`\`

---

### 3. agent-stop  (fires when the agent finishes a turn)

**JSON stdin:**
\`\`\`json
{
  "session_id": "string",
  "cwd": "string",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
\`\`\`

**IMPORTANT:** If \`stop_hook_active\` is true the agent was already triggered by a
stop-hook this turn — guard against it to avoid infinite loops.

**To send a follow-up message / re-trigger the agent** (exit 0, text on stdout):
\`\`\`bash
echo "Do X next"
\`\`\`

**To block / prevent finishing** (exit 2, message on stderr):
\`\`\`bash
echo "Not done yet" >&2; exit 2
\`\`\`

---

### File locations

| Scope   | Path pattern |
|---------|-------------|
| project | \`<repo>/.pi/autohooks/<hook-type>/<script-name>\` |
| global  | \`~/.pi/agent/autohooks/<hook-type>/<script-name>\` |

Project-local scripts take precedence over global ones when filenames collide.
Scripts are discovered fresh on every event — no restart needed after adding them.
`;

/**
 * Builds the LLM prompt for /make-hook.
 *
 * @param description - User's description of the desired hook behaviour
 * @param scope - "project" or "global"
 * @param cwd - Current working directory, used to compute the project path
 * @returns Prompt string ready to send as a user message
 */
function buildMakeHookPrompt(description: string, scope: "project" | "global", cwd: string): string {
	const projectBase = `${cwd}/.pi/autohooks`;
	const globalBase = `~/.pi/agent/autohooks`;
	const base = scope === "project" ? projectBase : globalBase;

	return `You are helping the user create a hook script for the pi-autohooks system.

## User's request
${description}

## Target scope: ${scope.toUpperCase()}
Scripts must be placed under: \`${base}/<hook-type>/\`

${HOOK_RECIPES}

## Your task
1. Decide which hook type(s) best satisfy the request (pre-tool-use, post-tool-use, and/or agent-stop).
2. Write the script(s) in bash or Python (choose whichever fits best or matches user preference).
3. Create the necessary directory/directories if they don't exist.
4. Write each script to the correct path under \`${base}/\`.
5. Make each script executable with \`chmod +x\`.
6. Show the user what was created and briefly explain when each script will fire.

Follow the JSON protocol exactly. Do not add unnecessary complexity — keep scripts focused on the described behaviour.`;
}

export default function (pi: ExtensionAPI) {
	// Tracks whether the most recent agent run was triggered by an agent-stop hook.
	// Passed to stop scripts as stop_hook_active so they can avoid infinite loops.
	let stopHookActive = false;

	// --- /make-hook command -------------------------------------------------
	pi.registerCommand("make-hook", {
		description: "Generate and install a hook script via the LLM",
		handler: async (args, ctx) => {
			let description = args.trim();

			if (!description) {
				const input = await ctx.ui.input(
					"Describe what the hook should do:",
					"e.g. log every tool call to /tmp/tool-calls.log"
				);
				if (!input) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
				description = input.trim();
			}

			const scope = await ctx.ui.select(
				"Install as project-level or global hook?",
				["project", "global"]
			);

			if (!scope) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			const prompt = buildMakeHookPrompt(description, scope as "project" | "global", ctx.cwd);
			pi.sendUserMessage(prompt);
		},
	});

	// --- pre-tool-use -------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		const scripts = getHookScripts("pre-tool-use", ctx.cwd);
		if (scripts.length === 0) return;

		const input: PreToolUseInput = {
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			hook_event_name: "PreToolUse",
			tool_name: event.toolName,
			tool_input: event.input as Record<string, unknown>,
			tool_use_id: event.toolCallId,
		};

		for (const script of scripts) {
			const result = await runScript(script, input);

			const blockReason = getBlockReason(result);
			if (blockReason !== null) {
				return { block: true, reason: blockReason };
			}

			if (result.code !== 0 && result.code !== 2) {
				// Non-blocking error — log to stderr and continue
				console.error(
					`[hooks-runner] pre-tool-use script ${basename(script)} exited with code ${result.code}: ${result.stderr}`
				);
				continue;
			}

			const text = extractText(result.stdout);
			if (text) {
				pi.sendUserMessage(text, { deliverAs: "steer" });
			}
		}
	});

	// --- post-tool-use ------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		const scripts = getHookScripts("post-tool-use", ctx.cwd);
		if (scripts.length === 0) return;

		const input: PostToolUseInput = {
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			hook_event_name: "PostToolUse",
			tool_name: event.toolName,
			tool_input: event.input as Record<string, unknown>,
			tool_response: {
				content: event.content,
				isError: event.isError,
			},
			tool_use_id: event.toolCallId,
		};

		for (const script of scripts) {
			const result = await runScript(script, input);

			if (result.code === 2) {
				const msg = result.stderr.trim() || "Hook error";
				pi.sendUserMessage(msg, { deliverAs: "followUp" });
				continue;
			}

			if (result.code !== 0) {
				console.error(
					`[hooks-runner] post-tool-use script ${basename(script)} exited with code ${result.code}: ${result.stderr}`
				);
				continue;
			}

			const text = extractText(result.stdout);
			if (text) {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		}
	});

	// --- agent-stop ---------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		const scripts = getHookScripts("agent-stop", ctx.cwd);
		if (scripts.length === 0) return;

		// Capture and reset before running scripts so any re-trigger this turn
		// reflects the current state, not a stale value from the previous run.
		const wasStopHookActive = stopHookActive;
		stopHookActive = false;

		const input: StopInput = {
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			hook_event_name: "Stop",
			stop_hook_active: wasStopHookActive,
		};

		for (const script of scripts) {
			const result = await runScript(script, input);

			if (result.code === 2) {
				const msg = result.stderr.trim() || "Hook error";
				stopHookActive = true;
				pi.sendUserMessage(msg);
				continue;
			}

			if (result.code !== 0) {
				console.error(
					`[hooks-runner] agent-stop script ${basename(script)} exited with code ${result.code}: ${result.stderr}`
				);
				continue;
			}

			const text = extractText(result.stdout);
			if (text) {
				stopHookActive = true;
				pi.sendUserMessage(text);
			}
		}
	});
}
