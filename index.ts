/**
 * pi-subagent-tool — run isolated child pi agents from one `subagent` tool call.
 *
 * How it works
 * ------------
 * Each requested agent runs in its own `pi -p --mode json` child process with
 * `--no-extensions`, so a subagent can never recursively spawn the parent tool
 * set by accident. Agent behaviour comes from `agents/<name>.md`:
 *
 *   ---
 *   name: scout
 *   description: Fast read-only reconnaissance over a codebase.
 *   model: opencode/space-bunny-free     # optional, defaults to the parent model
 *   thinking: low                        # optional
 *   tools: read, grep, find, ls, bash    # optional allowlist
 *   extensions:                          # optional extra extensions for the child
 *     - ./agents/helpers/my-ext.ts
 *   ---
 *   You are a read-only reconnaissance agent. ...
 *
 * Safety rails
 * ------------
 * - Depth limit: `PI_SUBAGENT_DEPTH` is incremented per generation and the tool
 *   refuses to register itself beyond `maxDepth` (default 1), so nesting cannot
 *   fork-bomb the machine.
 * - `PI_SUBAGENT_ALLOWED` narrows the agent registry a child may use.
 * - Cancellation: `ctx.signal` aborts the tool call, which SIGTERMs the child
 *   and escalates to SIGKILL after 3s.
 * - Accounting: child `usage` is summed into the tool result so the parent
 *   session's token totals stay accurate.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	filePath: string;
}

interface SubagentTask {
	agent: string;
	task: string;
}

type TaskStatus = "pending" | "running" | "completed" | "failed";

interface TaskResult {
	agent: string;
	status: TaskStatus;
	task: string;
	output: string;
	error?: string;
	durationMs: number;
	usage?: Usage;
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

interface SubagentDetails {
	depth: number;
	results: TaskResult[];
}

interface TaskProgress {
	agent: string;
	status: TaskStatus;
	task: string;
	elapsedMs: number;
	toolsUsed: string[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, "agents");

const MAX_DEPTH = Number.parseInt(process.env.PI_SUBAGENT_MAX_DEPTH ?? "1", 10) || 1;
const MAX_PARALLEL = Math.min(Math.max(Number.parseInt(process.env.PI_SUBAGENT_MAX_PARALLEL ?? "3", 10) || 3, 1), 8);
const DEFAULT_AGENT = process.env.PI_SUBAGENT_DEFAULT ?? "worker";
const OUTPUT_CHAR_LIMIT = Number.parseInt(process.env.PI_SUBAGENT_OUTPUT_LIMIT ?? "20000", 10) || 20000;
const CHILD_TIMEOUT_MS = Number.parseInt(process.env.PI_SUBAGENT_TIMEOUT_MS ?? "900000", 10) || 900000;
const UPDATE_THROTTLE_MS = 400;

function currentDepth(): number {
	const raw = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function allowedAgents(): Set<string> | undefined {
	const raw = process.env.PI_SUBAGENT_ALLOWED?.trim();
	if (!raw) return undefined;
	return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Minimal YAML-ish frontmatter reader (scalars, inline lists, `- item` lists).
 * Deliberately local: importing pi's parser would pull the whole pi core module
 * graph into this extension and add ~180ms to every pi startup.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (!match) return { frontmatter: {}, body: raw };
	const frontmatter: Record<string, unknown> = {};
	let currentKey: string | undefined;
	for (const line of match[1].split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const listItem = /^\s*-\s+(.*)$/.exec(line);
		if (listItem && currentKey) {
			const existing = frontmatter[currentKey];
			const value = unquote(listItem[1].trim());
			if (Array.isArray(existing)) existing.push(value);
			else frontmatter[currentKey] = [value];
			continue;
		}
		const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
		if (!pair) continue;
		currentKey = pair[1];
		const inline = pair[2].trim();
		if (inline === "") {
			frontmatter[currentKey] = "";
		} else if (inline.startsWith("[") && inline.endsWith("]")) {
			frontmatter[currentKey] = inline
				.slice(1, -1)
				.split(",")
				.map((s) => unquote(s.trim()))
				.filter(Boolean);
		} else {
			frontmatter[currentKey] = unquote(inline);
		}
	}
	return { frontmatter, body: raw.slice(match[0].length) };
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

function coerceList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value === "string") {
		return value.split(",").map((v) => v.trim()).filter(Boolean);
	}
	return undefined;
}

function loadAgents(): Map<string, AgentConfig> {
	const agents = new Map<string, AgentConfig>();
	let entries: string[];
	try {
		entries = fs.readdirSync(AGENTS_DIR);
	} catch {
		return agents;
	}
	const allow = allowedAgents();

	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(AGENTS_DIR, entry);
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter(raw);
		const fm = frontmatter;
		const name = String(fm.name ?? entry.replace(/\.md$/, "")).trim();
		if (!name) continue;
		if (allow && !allow.has(name)) continue;
		agents.set(name, {
			name,
			description: String(fm.description ?? `${name} subagent`).trim(),
			systemPrompt: (body ?? raw).trim(),
			model: typeof fm.model === "string" ? fm.model.trim() : undefined,
			thinking: typeof fm.thinking === "string" ? fm.thinking.trim() : undefined,
			tools: coerceList(fm.tools),
			extensions: coerceList(fm.extensions),
			filePath,
		});
	}
	return agents;
}

// ---------------------------------------------------------------------------
// Child process plumbing
// ---------------------------------------------------------------------------

function resolvePiCommand(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry && /\.(m?js|cjs)$/i.test(entry)) {
		return { command: process.execPath, baseArgs: [entry] };
	}
	return { command: "pi", baseArgs: [] };
}

function buildChildArgs(
	agent: AgentConfig,
	task: string,
	parentModel: string | undefined,
	allowed: Set<string> | undefined,
): { args: string[]; childAllow?: string } {
	const args: string[] = [
		"-p",
		"--mode",
		"json",
		"--no-session",
		// isolation: no extension discovery at all, only what the agent opts into
		"--no-extensions",
		"--no-prompt-templates",
		"--no-themes",
	];
	for (const ext of agent.extensions ?? []) {
		const resolved = path.isAbsolute(ext) ? ext : path.resolve(HERE, ext);
		args.push("--extension", resolved);
	}
	if (agent.systemPrompt) args.push("--append-system-prompt", agent.systemPrompt);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (agent.thinking) args.push("--thinking", agent.thinking);

	const model = agent.model ?? parentModel;
	if (model) {
		const slash = model.indexOf("/");
		if (slash > 0) {
			args.push("--provider", model.slice(0, slash));
			args.push("--model", model.slice(slash + 1));
		} else {
			args.push("--model", model);
		}
	}

	// keep registry metadata honest in the child, and let a grandchild stay bounded
	const childAllow = allowed ? [...allowed].join(",") : undefined;
	args.push(task);
	return { args, childAllow };
}

interface RunOutcome {
	output: string;
	error?: string;
	usage?: Usage;
	durationMs: number;
	toolsUsed: string[];
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
			parts.push(String((item as { text?: unknown }).text ?? ""));
		}
	}
	return parts.join("\n");
}

function addUsage(target: Usage, delta: Usage | undefined): void {
	if (!delta) return;
	target.input = (target.input ?? 0) + (delta.input ?? 0);
	target.output = (target.output ?? 0) + (delta.output ?? 0);
	target.cacheRead = (target.cacheRead ?? 0) + (delta.cacheRead ?? 0);
	target.cacheWrite = (target.cacheWrite ?? 0) + (delta.cacheWrite ?? 0);
	target.totalTokens = (target.totalTokens ?? 0) + (delta.totalTokens ?? 0);
}

function runAgent(
	agent: AgentConfig,
	task: string,
	parentModel: string | undefined,
	allowed: Set<string> | undefined,
	signal: AbortSignal | undefined,
	onTick: (toolsUsed: string[]) => void,
): Promise<RunOutcome> {
	const started = Date.now();
	const { command, baseArgs } = resolvePiCommand();
	const { args, childAllow } = buildChildArgs(agent, task, parentModel, allowed);

	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	env.PI_SUBAGENT_DEPTH = String(currentDepth() + 1);
	if (childAllow) env.PI_SUBAGENT_ALLOWED = childAllow;
	else delete env.PI_SUBAGENT_ALLOWED;

	return new Promise<RunOutcome>((resolve) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command, [...baseArgs, ...args], {
				cwd: process.cwd(),
				env,
				stdio: ["ignore", "pipe", "pipe"],
			}) as ChildProcessWithoutNullStreams;
		} catch (err) {
			resolve({ output: "", error: `failed to spawn pi: ${String(err)}`, durationMs: Date.now() - started, toolsUsed: [] });
			return;
		}

		const usage: Usage = {};
		const toolsUsed: string[] = [];
		let answer = "";
		let stderr = "";
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let lastTick = 0;
		let stdoutBuf = "";
		let childError = "";

		const finish = (error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			clearTimeout(timeoutTimer);
			signal?.removeEventListener("abort", onAbort);
			const text = answer.trim() || (error ? "" : stderr.trim());
			resolve({
				output: text,
				error,
				usage: usage.totalTokens || usage.input || usage.output ? usage : undefined,
				durationMs: Date.now() - started,
				toolsUsed,
			});
		};

		const kill = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 3000);
		};

		const onAbort = () => {
			kill();
			finish("aborted by user");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const timeoutTimer = setTimeout(() => {
			kill();
			finish(`timed out after ${Math.round(CHILD_TIMEOUT_MS / 1000)}s`);
		}, CHILD_TIMEOUT_MS);
		// do not hold the event loop open just for the watchdog
		(timeoutTimer as unknown as { unref?: () => void }).unref?.();

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBuf += chunk;
			let nl = stdoutBuf.indexOf("\n");
			while (nl >= 0) {
				const line = stdoutBuf.slice(0, nl).trim();
				stdoutBuf = stdoutBuf.slice(nl + 1);
				nl = stdoutBuf.indexOf("\n");
				if (!line) continue;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				const type = event.type;
				if (type === "tool_execution_start") {
					const name = String((event as { toolName?: string }).toolName ?? "tool");
					toolsUsed.push(name);
					const now = Date.now();
					if (now - lastTick > UPDATE_THROTTLE_MS) {
						lastTick = now;
						onTick([...toolsUsed]);
					}
				} else if (type === "message_end") {
					const message = (event as { message?: Record<string, unknown> }).message;
					if (!message || typeof message !== "object") continue;
					const role = message.role;
					// A provider-level failure (401/403/429/5xx) arrives as a
					// message_end with stopReason "error" and an empty content
					// array. The child still exits 0 and prints nothing to stderr,
					// so without this the tool would report a successful subagent
					// that returned no output and the model would have no idea why.
					const providerError =
						typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
					if (providerError) childError = providerError;
					if (role === "assistant") {
						const text = extractText(message.content).trim();
						if (text) answer = text;
						addUsage(usage, message.usage as Usage | undefined);
					} else if (role === "toolResult") {
						addUsage(usage, message.usage as Usage | undefined);
					}
				} else if (type === "agent_end" || type === "agent_settled") {
					// keep draining; the process exit is the real completion signal
				}
			}
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (stderr.length > 8000) stderr = stderr.slice(-8000);
		});

		child.on("error", (err) => finish(`subagent process error: ${err.message}`));
		child.on("close", (code, sig) => {
			if (childError) {
				const hint = explainChildFailure(childError);
				finish(
					`subagent ${agent.name} failed: ${childError}` + (hint ? `\n\n${hint}` : ""),
				);
			} else if (code === 0 || (code === null && sig === null)) finish();
			else if (sig) finish(`subagent ${agent.name} killed (${sig})`);
			else {
				const detail = stderr.trim().slice(-500);
				const hint = explainChildFailure(stderr);
				finish(
					`subagent ${agent.name} exited with code ${code}: ${detail}` +
						(hint ? `\n\n${hint}` : ""),
				);
			}
		});
	});
}

/**
 * Children are launched with `--no-extensions` so they inherit no parent
 * extension set. That isolation is the point, but it also means a provider
 * which only works with a local patch extension fails with an opaque 403 —
 * opencode's free tier is the common case, since every opencode free model
 * except `space-bunny-free` is rejected outside the OpenCode client.
 *
 * Turn that into an actionable message instead of passing the raw provider
 * text up, otherwise the model just sees a 403 and retries.
 */
function explainChildFailure(stderr: string): string | undefined {
	if (!/FreeTierError|can only be used from within/i.test(stderr)) return undefined;
	const patch = path.join(os.homedir(), ".pi", "agent", "extensions", "opencode-free-tier", "index.ts");
	return [
		"The child pi runs with --no-extensions, so provider patches are not loaded.",
		"Add the patch to this agent's frontmatter:",
		"",
		"  extensions:",
		`    - ${patch}`,
		"",
		"Only needed for opencode free-tier models other than space-bunny-free,",
		"which answers without the patch.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const head = text.slice(0, Math.floor(limit * 0.7));
	const tail = text.slice(-Math.floor(limit * 0.25));
	return { text: `${head}\n\n[... ${text.length - head.length - tail.length} chars omitted ...]\n\n${tail}`, truncated: true };
}

export default function subagentTool(pi: ExtensionAPI): void {
	const depth = currentDepth();
	const agents = loadAgents();

	pi.registerCommand("subagents", {
		description: "List available subagents (or run one: /subagents <name> <task>)",
		handler: async (args, ctx) => {
			const names = [...agents.keys()];
			if (names.length === 0) {
				ctx.ui.notify(`No subagents found in ${AGENTS_DIR}`, "warning");
				return;
			}
			const arg = args.trim();
			if (arg) {
				const [name, ...rest] = arg.split(/\s+/);
				const agent = agents.get(name);
				const task = rest.join(" ");
				if (!agent) {
					ctx.ui.notify(`Unknown subagent "${name}". Known: ${names.join(", ")}`, "error");
					return;
				}
				if (!task) {
					ctx.ui.notify(`Usage: /subagents ${name} <task>`, "warning");
					return;
				}
				pi.sendUserMessage(`Use the subagent tool: agent="${agent.name}", task=${JSON.stringify(task)}`);
				return;
			}
			const lines = [`${names.length} subagent(s) in ${AGENTS_DIR} (depth ${depth}/${MAX_DEPTH}):`];
			for (const agent of agents.values()) {
				lines.push(`  ${agent.name}: ${agent.description}`);
				lines.push(`    model=${agent.model ?? "inherit"} thinking=${agent.thinking ?? "default"} tools=${agent.tools?.join(",") ?? "all"}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	if (depth >= MAX_DEPTH) return; // bounded nesting: children get no subagent tool
	if (agents.size === 0) return;

	const catalog = [...agents.values()]
		.map((a) => `- ${a.name}: ${a.description}`)
		.join("\n");

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to an isolated subagent (a separate pi process with its own context).",
			"Use sparingly: only when the user explicitly asks for delegation, or when the task is big and can safely be spread across many agents at once.",
			`Available subagents:\n${catalog}`,
			"Provide either a single `task` (+ optional `agent`) or a `batch` of tasks to run in parallel.",
			"Each subagent returns only its final answer, so brief it completely and ask for a concise report.",
		].join("\n"),
		promptSnippet: "delegate a task to an isolated subagent process (only when the user asks, or the task is large and parallelizable)",
		promptGuidelines: [
			"Use subagent ONLY when (a) the user explicitly asks for it, or (b) the task is big and can safely be spread across many agents at once — many independent work items, each self-contained enough to run without further clarification.",
			"Do NOT use subagent for simpler agentic tasks: single file reads, greps, searches, quick lookups, small edits, or anything you can handle directly with a few tool calls. Prefer doing it yourself.",
			"Prefer one subagent per independent question instead of a long sequential plan.",
			"Give the subagent everything it needs: file paths, what to report, and the output format.",
		],
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "The task for a single subagent run." })),
			agent: Type.Optional(Type.String({ description: `Subagent name. Defaults to "${DEFAULT_AGENT}" when it exists.` })),
			batch: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Subagent name." }),
						task: Type.String({ description: "Self-contained task for that subagent." }),
					}),
					{ description: "Independent tasks to run concurrently (max " + MAX_PARALLEL + ").", maxItems: MAX_PARALLEL },
				),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const requested: SubagentTask[] = [];
			if (Array.isArray(params.batch) && params.batch.length > 0) {
				for (const item of params.batch.slice(0, MAX_PARALLEL)) {
					requested.push({ agent: item.agent, task: item.task });
				}
			} else if (params.task && params.task.trim()) {
				requested.push({ agent: params.agent ?? DEFAULT_AGENT, task: params.task });
			} else {
				throw new Error("subagent: provide `task` (with optional `agent`) or a `batch` of tasks.");
			}

			const unknown = requested.filter((t) => !agents.has(t.agent));
			if (unknown.length > 0) {
				throw new Error(
					`subagent: unknown agent(s) ${unknown.map((t) => `"${t.agent}"`).join(", ")}. Known: ${[...agents.keys()].join(", ")}`,
				);
			}
			if (requested.length > MAX_PARALLEL) {
				throw new Error(`subagent: at most ${MAX_PARALLEL} tasks per call (got ${requested.length}).`);
			}

			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const progress = new Map<string, TaskProgress>();
			for (const t of requested) progress.set(t.task, { agent: t.agent, status: "pending", task: t.task, elapsedMs: 0, toolsUsed: [] });

			const emit = () => {
				if (!onUpdate) return;
				const snapshot: SubagentDetails = {
					depth,
					results: [...progress.values()].map((p) => ({
						agent: p.agent,
						status: p.status,
						task: p.task,
						output: "",
						durationMs: p.elapsedMs,
					})),
				};
				const lines = [...progress.values()].map(
					(p) => `${p.agent} [${p.status}] ${(p.elapsedMs / 1000).toFixed(1)}s${p.toolsUsed.length ? ` tools: ${[...new Set(p.toolsUsed)].join(",")}` : ""}`,
				);
				onUpdate({
					content: [{ type: "text", text: `subagents running:\n${lines.join("\n")}` }],
					details: snapshot,
				});
			};

			const runOne = async (t: SubagentTask): Promise<TaskResult> => {
				const agent = agents.get(t.agent)!;
				const state = progress.get(t.task)!;
				const t0 = Date.now();
				state.status = "running";
				emit();
				const outcome = await runAgent(
					agent,
					t.task,
					parentModel,
					allowedAgents(),
					signal,
					(toolsUsed) => {
						state.toolsUsed = toolsUsed;
						state.elapsedMs = Date.now() - t0;
						emit();
					},
				);
				state.status = outcome.error ? "failed" : "completed";
				state.elapsedMs = outcome.durationMs;
				emit();
				return {
					agent: t.agent,
					status: state.status,
					task: t.task,
					output: outcome.output,
					error: outcome.error,
					durationMs: outcome.durationMs,
					usage: outcome.usage,
				};
			};

			const results = await Promise.all(requested.map(runOne));

			const total: Usage = {};
			for (const r of results) addUsage(total, r.usage);

			const content = results.map((r) => {
				const body = r.error ? `FAILED: ${r.error}` : r.output || "(no output)";
				const { text, truncated } = truncate(body, OUTPUT_CHAR_LIMIT);
				const header = `### ${r.agent} (${r.status}, ${(r.durationMs / 1000).toFixed(1)}s)\ntask: ${r.task}`;
				const footer = truncated ? `\n[output truncated at ${OUTPUT_CHAR_LIMIT} chars]` : "";
				return { type: "text" as const, text: `${header}\n${text}${footer}` };
			});

			return { content, details: { depth, results }, usage: total };
		},
	});
}
