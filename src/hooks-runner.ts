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
import { existsSync, readdirSync, statSync, readFileSync, appendFileSync } from "fs";
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
// Claude Code settings.json hook types
// ---------------------------------------------------------------------------

interface SettingsHookEntry {
	type?: string;
	command?: string;
	url?: string;
	prompt?: string;
	model?: string;
	timeout?: number;
	allowedEnvVars?: string[];
	args?: string[];
	/** @deprecated use `if` */
	if?: string;
}

interface SettingsHookGroup {
	matcher?: string;
	hooks: SettingsHookEntry[];
}

interface ClaudeSettings {
	hooks?: Record<string, SettingsHookGroup[]>;
}

// ---------------------------------------------------------------------------
// Settings-based hook discovery (reads ~/.claude/settings.json)
// ---------------------------------------------------------------------------

/**
 * Event mapping from Claude Code hook event names to pi-autohooks event names.
 * Only events that pi-autohooks supports are listed.
 */
const CLAUDE_TO_PI_EVENT: Record<string, string> = {
	PreToolUse: "pre-tool-use",
	PostToolUse: "post-tool-use",
	Stop: "agent-stop",
	SessionStart: "session-start",
};

/**
 * Loads hook configuration from Claude Code settings files.
 * Checks ~/.claude/settings.json (global) and .claude/settings.json (project).
 *
 * @param cwd - Current working directory (project root)
 * @returns Parsed hooks config, or null if no settings file has hooks
 */
function loadSettingsHooks(cwd: string): ClaudeSettings["hooks"] | null {
	const candidates = [
		join(homedir(), ".claude", "settings.json"),
		join(cwd, ".claude", "settings.json"),
	];

	let merged: ClaudeSettings["hooks"] | null = null;

	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			const raw = readFileSync(filePath, "utf-8");
			const parsed: ClaudeSettings = JSON.parse(raw);
			if (parsed.hooks && Object.keys(parsed.hooks).length > 0) {
				if (merged === null) {
					merged = {};
				}
				// Project settings override global ones for the same event key
				for (const [event, groups] of Object.entries(parsed.hooks)) {
					merged[event] = groups;
				}
			}
		} catch (err) {
			console.error(`[hooks-runner] Failed to parse hooks from ${filePath}: ${err}`);
		}
	}

	return merged;
}

/**
 * Returns the list of settings-based hooks that match a given pi event.
 *
 * @param piEvent - pi-autohooks event name (e.g. "pre-tool-use")
 * @param toolName - Tool name for matcher filtering (only for tool events)
 * @param cwd - Current working directory
 * @returns Array of hook entries with their matcher
 */
function getSettingsHooksForEvent(
	piEvent: string,
	toolName: string | undefined,
	cwd: string,
): { entry: SettingsHookEntry; matcher: string }[] {
	const hooks = loadSettingsHooks(cwd);
	if (!hooks) return [];

	const results: { entry: SettingsHookEntry; matcher: string }[] = [];

	for (const [claudeEvent, groups] of Object.entries(hooks)) {
		const mappedEvent = CLAUDE_TO_PI_EVENT[claudeEvent];
		if (mappedEvent !== piEvent) continue;

		for (const group of groups) {
			const matcher = group.matcher ?? "";

			// For tool events, check if the matcher matches the tool name
			if (toolName !== undefined && matcher) {
				// Matcher can be a pipe-separated list of names or a regex
				const patterns = matcher.split("|").map((p) => p.trim()).filter(Boolean);
				const matches = patterns.some((pattern) => {
					try {
						return new RegExp(`^${pattern}$`).test(toolName);
					} catch {
						return toolName === pattern;
					}
				});
				if (!matches) continue;
			}

			for (const entry of group.hooks) {
				results.push({ entry, matcher });
			}
		}
	}

	return results;
}

/**
 * Runs a settings-based hook command (type: "command").
 * Expands ~ to the home directory in the command string.
 *
 * @param entry - The hook entry from settings.json
 * @param input - JSON input to pass via stdin
 * @returns Script execution result
 */
function runSettingsCommand(
	entry: SettingsHookEntry,
	input: unknown,
): Promise<ScriptResult> {
	const command = (entry.command ?? "").replace(/^~/, homedir());
	if (!command) {
		return Promise.resolve({ stdout: "", stderr: "No command specified", code: 1 });
	}

	return new Promise((resolve) => {
		const proc = spawn("sh", ["-c", command], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timeout = entry.timeout ?? SCRIPT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 2000);
			resolve({ stdout, stderr: stderr + "\n[hook timed out]", code: 1 });
		}, timeout);

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

/**
 * Formats a hook entry for display in the startup summary.
 *
 * @param entry - The hook entry
 * @param eventName - The pi event name
 * @param matcher - The matcher pattern
 * @returns Formatted display string
 */
function formatHookDisplay(
	entry: SettingsHookEntry,
	eventName: string,
	matcher: string,
): string {
	const type = entry.type ?? "command";
	const cmd = entry.command ?? entry.url ?? entry.prompt ?? "(no command)";
	const truncated = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
	const matchStr = matcher ? ` [matcher: ${matcher}]` : "";
	return `  • ${eventName}${matchStr} (${type}): ${truncated}`;
}

// ---------------------------------------------------------------------------
// Script discovery (directory-based)
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

// ---------------------------------------------------------------------------
// Hook execution log
// ---------------------------------------------------------------------------

const LOG_FILE = join(homedir(), ".pi", "autohooks.log");

/**
 * Whether hook execution logging is enabled.
 * Controlled by the ENABLE_HOOK_LOG environment variable.
 * Set to "1" or "true" to enable.
 */
const HOOK_LOG_ENABLED = process.env.ENABLE_HOOK_LOG === "1" || process.env.ENABLE_HOOK_LOG === "true";

/**
 * Appends a timestamped line to the hook execution log.
 * No-op unless ENABLE_HOOK_LOG=1 is set.
 *
 * @param message - The log message to append
 */
function logHook(message: string): void {
	if (!HOOK_LOG_ENABLED) return;
	try {
		const timestamp = new Date().toISOString();
		appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
	} catch {
		// Silently ignore log write failures
	}
}

export default function (pi: ExtensionAPI) {
	// Tracks whether the most recent agent run was triggered by an agent-stop hook.
	// Passed to stop scripts as stop_hook_active so they can avoid infinite loops.
	let stopHookActive = false;

	// --- Startup: show loaded hooks ----------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		try {
			const cwd = ctx.cwd;
			logHook(`session_start cwd=${cwd}`);

			const settingsHooks = loadSettingsHooks(cwd);

			const lines: string[] = [];

			// Show settings.json hooks
			if (settingsHooks && Object.keys(settingsHooks).length > 0) {
				lines.push("📋 Loaded hooks from settings.json:");
				for (const [claudeEvent, groups] of Object.entries(settingsHooks)) {
					const mappedEvent = CLAUDE_TO_PI_EVENT[claudeEvent] ?? claudeEvent;
					for (const group of groups) {
						for (const entry of group.hooks) {
							lines.push(formatHookDisplay(entry, mappedEvent, group.matcher ?? ""));
							logHook(`  settings hook: ${mappedEvent} matcher=${group.matcher ?? ""} cmd=${(entry.command ?? "").slice(0, 80)}`);
						}
					}
				}
			}

			// Show directory-based hooks
			const dirLines: string[] = [];
			for (const piEvent of ["pre-tool-use", "post-tool-use", "agent-stop"] as const) {
				const scripts = getHookScripts(piEvent, cwd);
				for (const script of scripts) {
					const relPath = script.startsWith(cwd)
						? "." + script.slice(cwd.length)
						: script.replace(homedir(), "~");
					dirLines.push(`  • ${piEvent} (script): ${relPath}`);
					logHook(`  dir hook: ${piEvent} script=${relPath}`);
				}
			}
			if (dirLines.length > 0) {
				if (lines.length > 0) lines.push("");
				lines.push("📋 Loaded hooks from directories:");
				lines.push(...dirLines);
			}

			if (lines.length > 0) {
				if (HOOK_LOG_ENABLED) {
					lines.push("");
					lines.push("\x1b[41m\x1b[97m⚠ HOOK LOG ENABLED ~/.pi/autohooks.log ⚠\x1b[0m");
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				console.log("[hooks-runner] No hooks found in settings.json or directories");
			}
		} catch (err) {
			console.error("[hooks-runner] Error in session_start hook display:", err);
		}
	});

	// --- /hooks command (show loaded hooks on demand) ----------------------
	pi.registerCommand("hooks", {
		description: "Show all loaded hooks from settings.json and directories",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const settingsHooks = loadSettingsHooks(cwd);

			const lines: string[] = [];

			if (settingsHooks && Object.keys(settingsHooks).length > 0) {
				lines.push("📋 Hooks from settings.json:");
				for (const [claudeEvent, groups] of Object.entries(settingsHooks)) {
					const mappedEvent = CLAUDE_TO_PI_EVENT[claudeEvent] ?? claudeEvent;
					for (const group of groups) {
						for (const entry of group.hooks) {
							lines.push(formatHookDisplay(entry, mappedEvent, group.matcher ?? ""));
						}
					}
				}
			} else {
				lines.push("No hooks found in settings.json.");
			}

			const dirLines: string[] = [];
			for (const piEvent of ["pre-tool-use", "post-tool-use", "agent-stop"] as const) {
				const scripts = getHookScripts(piEvent, cwd);
				for (const script of scripts) {
					const relPath = script.startsWith(cwd)
						? "." + script.slice(cwd.length)
						: script.replace(homedir(), "~");
					dirLines.push(`  • ${piEvent} (script): ${relPath}`);
				}
			}
			if (dirLines.length > 0) {
				lines.push("");
				lines.push("📋 Hooks from directories:");
				lines.push(...dirLines);
			} else {
				lines.push("");
				lines.push("No hooks found in directories.");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

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
		const settingsHooks = getSettingsHooksForEvent("pre-tool-use", event.toolName, ctx.cwd);

		if (scripts.length === 0 && settingsHooks.length === 0) return;

		logHook(`pre-tool-use tool=${event.toolName} id=${event.toolCallId} dir_scripts=${scripts.length} settings_hooks=${settingsHooks.length}`);

		const input: PreToolUseInput = {
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			hook_event_name: "PreToolUse",
			tool_name: event.toolName,
			tool_input: event.input as Record<string, unknown>,
			tool_use_id: event.toolCallId,
		};

		// Run directory-based scripts first
		for (const script of scripts) {
			logHook(`pre-tool-use dir script=${basename(script)}`);
			const result = await runScript(script, input);

			const blockReason = getBlockReason(result);
			if (blockReason !== null) {
				logHook(`pre-tool-use BLOCKED by dir script=${basename(script)} reason=${blockReason}`);
				return { block: true, reason: blockReason };
			}

			if (result.code !== 0 && result.code !== 2) {
				console.error(
					`[hooks-runner] pre-tool-use script ${basename(script)} exited with code ${result.code}: ${result.stderr}`
				);
				continue;
			}

			const text = extractText(result.stdout);
			if (text) {
				logHook(`pre-tool-use dir script=${basename(script)} output=${text.slice(0, 100)}`);
				pi.sendUserMessage(text, { deliverAs: "steer" });
			}
		}

		// Then run settings-based hooks
		for (const { entry } of settingsHooks) {
			if (entry.type && entry.type !== "command") continue; // Only command type supported for now

			logHook(`pre-tool-use settings cmd=${(entry.command ?? "").slice(0, 80)}`);
			const result = await runSettingsCommand(entry, input);

			const blockReason = getBlockReason(result);
			if (blockReason !== null) {
				logHook(`pre-tool-use BLOCKED by settings hook reason=${blockReason}`);
				return { block: true, reason: blockReason };
			}

			if (result.code !== 0 && result.code !== 2) {
				console.error(
					`[hooks-runner] settings pre-tool-use hook exited with code ${result.code}: ${result.stderr}`
				);
				continue;
			}

			const text = extractText(result.stdout);
			if (text) {
				logHook(`pre-tool-use settings hook output=${text.slice(0, 100)}`);
				pi.sendUserMessage(text, { deliverAs: "steer" });
			}
		}
	});

	// --- post-tool-use ------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		const scripts = getHookScripts("post-tool-use", ctx.cwd);
		const settingsHooks = getSettingsHooksForEvent("post-tool-use", event.toolName, ctx.cwd);

		if (scripts.length === 0 && settingsHooks.length === 0) return;

		logHook(`post-tool-use tool=${event.toolName} id=${event.toolCallId} dir_scripts=${scripts.length} settings_hooks=${settingsHooks.length}`);

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

		// Run directory-based scripts first
		for (const script of scripts) {
			logHook(`post-tool-use dir script=${basename(script)}`);
			const result = await runScript(script, input);

			if (result.code === 2) {
				const msg = result.stderr.trim() || "Hook error";
				logHook(`post-tool-use dir script=${basename(script)} blocked: ${msg.slice(0, 100)}`);
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
				logHook(`post-tool-use dir script=${basename(script)} output=${text.slice(0, 100)}`);
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		}

		// Then run settings-based hooks
		for (const { entry } of settingsHooks) {
			if (entry.type && entry.type !== "command") continue;

			logHook(`post-tool-use settings cmd=${(entry.command ?? "").slice(0, 80)}`);
			const result = await runSettingsCommand(entry, input);

			if (result.code === 2) {
				const msg = result.stderr.trim() || "Hook error";
				logHook(`post-tool-use settings hook blocked: ${msg.slice(0, 100)}`);
				pi.sendUserMessage(msg, { deliverAs: "followUp" });
				continue;
			}

			if (result.code !== 0) {
				console.error(
					`[hooks-runner] settings post-tool-use hook exited with code ${result.code}: ${result.stderr}`
				);
				continue;
			}

			const text = extractText(result.stdout);
			if (text) {
				logHook(`post-tool-use settings hook output=${text.slice(0, 100)}`);
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		}
	});

	// --- agent-stop ---------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		const scripts = getHookScripts("agent-stop", ctx.cwd);
		const settingsHooks = getSettingsHooksForEvent("agent-stop", undefined, ctx.cwd);

		if (scripts.length === 0 && settingsHooks.length === 0) return;

		logHook(`agent-stop dir_scripts=${scripts.length} settings_hooks=${settingsHooks.length} stop_hook_active=${stopHookActive}`);

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

		// Run directory-based scripts first
		for (const script of scripts) {
			logHook(`agent-stop dir script=${basename(script)}`);
			const result = await runScript(script, input);

			if (result.code === 2) {
				const msg = result.stderr.trim() || "Hook error";
				logHook(`agent-stop dir script=${basename(script)} blocked: ${msg.slice(0, 100)}`);
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
				logHook(`agent-stop dir script=${basename(script)} output=${text.slice(0, 100)}`);
				stopHookActive = true;
				pi.sendUserMessage(text);
			}
		}

		// Then run settings-based hooks
		for (const { entry } of settingsHooks) {
			if (entry.type && entry.type !== "command") continue;

			logHook(`agent-stop settings cmd=${(entry.command ?? "").slice(0, 80)}`);
			const result = await runSettingsCommand(entry, input);

			if (result.code === 2) {
				const msg = result.stderr.trim() || "Hook error";
				logHook(`agent-stop settings hook blocked: ${msg.slice(0, 100)}`);
				stopHookActive = true;
				pi.sendUserMessage(msg);
				continue;
			}

			if (result.code !== 0) {
				console.error(
					`[hooks-runner] settings agent-stop hook exited with code ${result.code}: ${result.stderr}`
				);
				continue;
			}

			const text = extractText(result.stdout);
			if (text) {
				logHook(`agent-stop settings hook output=${text.slice(0, 100)}`);
				stopHookActive = true;
				pi.sendUserMessage(text);
			}
		}
	});
}
