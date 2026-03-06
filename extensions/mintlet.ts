/**
 * Mintlet — Blueprint-style conditional pipeline orchestrator
 *
 * Inspired by Stripe's Minions "Blueprints": hybrid state machines that combine
 * deterministic nodes (linting, running tests, git ops) with agentic nodes
 * (implementing, reviewing, fixing CI failures).
 *
 * Pipeline:
 *   [Context]  — deterministic: gather git log, README, package.json
 *   Scout(s)   — agentic: explore codebase (read-only, main repo)
 *   Planner    — agentic: produce implementation plan
 *   [Worktree] — deterministic: create isolated git worktree branch
 *   Builder(s) — agentic: implement the plan (runs in worktree)
 *   [Lint]     — deterministic: run linter (auto-detected); if fails → agentic lint-fix
 *   Reviewer(s)— agentic: code review gate (APPROVED/REJECTED)
 *   [Tests]    — deterministic: run test suite; if fails → agentic CI-fix
 *   Test Gate  — agentic: interpret test results (APPROVED/REJECTED)
 *   Playwright — agentic: browser tests (auto-spawned if flagged)
 *   Committer  — agentic: commit + push branch + open PR to main
 *   [Cleanup]  — deterministic: remove worktree
 *
 * Review gate loops back on REJECTED (up to 3×).
 * Test gate loops back on REJECTED (up to 2×).
 *
 * All features:
 *   ✓ Damage control  (bash safety rules from .pi/damage-control-rules.yaml)
 *   ✓ Pre-context hydration before scout
 *   ✓ Git worktree sandboxing (isolated branch per run)
 *   ✓ Deterministic lint + test nodes (no LLM waste for mechanical checks)
 *   ✓ Agentic lint-fix and CI-fix passes
 *   ✓ Task tracking   (live phase widget + footer)
 *   ✓ Parallel agents (multiple scouts, builders, reviewers, testers)
 *   ✓ Conditional routing (APPROVED/REJECTED gates)
 *   ✓ Playwright auto-detection
 *   ✓ Commit + PR automation
 *   ✓ Primary orchestrator (delegates everything — never codes itself)
 *
 * Commands:
 *   /pipeline     — show current pipeline status
 *   /agents       — list loaded mintlet agents
 *
 * Usage:  pi -e extensions/mintlet.ts   (or just `pi` if globally loaded)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { parse as yamlParse } from "yaml";
import { applyExtensionDefaults } from "./themeMap.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
}

interface AgentCardState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	elapsed: number;
	lastLine: string;
	task: string;
	queryCount: number;
}

type PhaseStatus = "pending" | "running" | "done" | "error" | "rejected" | "skipped";

// ─── Agent Colors (pi-pi style) ───────────────────────────────────────────────

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

const AGENT_COLORS: Record<string, { bg: string; br: string }> = {
	"scout":             { bg: "\x1b[48;2;18;50;80m",  br: "\x1b[38;2;60;160;220m"  }, // steel blue
	"planner":           { bg: "\x1b[48;2;18;65;30m",  br: "\x1b[38;2;55;175;90m"   }, // forest green
	"builder":           { bg: "\x1b[48;2;80;55;12m",  br: "\x1b[38;2;215;150;40m"  }, // amber
	"reviewer":          { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m"  }, // violet
	"tester":            { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m"  }, // teal
	"playwright-tester": { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m"   }, // crimson
	"committer":         { bg: "\x1b[48;2;28;42;80m",  br: "\x1b[38;2;85;120;210m"  }, // slate blue
};

interface PhaseState {
	name: string;
	label: string;
	agentNames: string[];
	status: PhaseStatus;
	retries: number;
	maxRetries: number;
	elapsed: number;
	lastWork: string;
	decision?: "approved" | "rejected";
	rejectionReason?: string;
}

interface DamageControlRule {
	pattern: string;
	reason: string;
	ask?: boolean;
}

interface DamageControlRules {
	bashToolPatterns?: DamageControlRule[];
	zeroAccessPaths?: string[];
	readOnlyPaths?: string[];
	noDeletePaths?: string[];
}

interface RunOptions {
	scouts?: number;
	builders?: number;
	reviewers?: number;
	testers?: number;
	skipCommit?: boolean;
	maxReviewRetries?: number;
	maxTestRetries?: number;
	lintCommand?: string;    // override auto-detected lint command
	testCommand?: string;    // override auto-detected test command
	useWorktree?: boolean;   // create isolated git worktree (default: true)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayName(name: string): string {
	return name
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function statusIcon(s: PhaseStatus): string {
	return s === "pending" ? "○"
		: s === "running" ? "◉"
		: s === "done" ? "✓"
		: s === "rejected" ? "✗"
		: s === "error" ? "✗"
		: s === "skipped" ? "─" : "?";
}

/** Parse APPROVED / REJECTED: <reason> from the tail of agent output */
function parseDecision(output: string): { approved: boolean; reason: string } {
	const lines = output.trim().split("\n").reverse();
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		if (/^APPROVED$/i.test(t)) return { approved: true, reason: "" };
		const rej = t.match(/^REJECTED:\s*(.+)$/i);
		if (rej) return { approved: false, reason: rej[1] };
		break;
	}
	for (const line of lines) {
		const t = line.trim();
		if (/^APPROVED$/i.test(t)) return { approved: true, reason: "" };
		const rej = t.match(/^REJECTED:\s*(.+)$/i);
		if (rej) return { approved: false, reason: rej[1] };
	}
	return { approved: true, reason: "" };
}

/** Detect if tester output is flagging that browser testing is needed */
function needsPlaywright(output: string): boolean {
	const lower = output.toLowerCase();
	return (
		lower.includes("playwright needed") ||
		lower.includes("playwright_needed") ||
		(lower.includes("playwright") && lower.includes("browser")) ||
		lower.includes("e2e test") ||
		lower.includes("end-to-end test") ||
		lower.includes("ui test") ||
		lower.includes("visual test")
	);
}

/** Merge multiple agent outputs into one combined report */
function mergeOutputs(outputs: string[], labels: string[]): string {
	if (outputs.length === 1) return outputs[0];
	return outputs
		.map((out, i) => `### ${labels[i]}\n\n${out.trim()}`)
		.join("\n\n---\n\n");
}

// ─── Damage Control ───────────────────────────────────────────────────────────

function loadDamageRules(cwd: string): DamageControlRules {
	const rulesPath = join(cwd, ".pi", "damage-control-rules.yaml");
	if (!existsSync(rulesPath)) return {};
	try {
		return yamlParse(readFileSync(rulesPath, "utf-8")) as DamageControlRules;
	} catch {
		return {};
	}
}

function checkBashCommand(
	command: string,
	rules: DamageControlRules,
): { blocked: boolean; ask: boolean; reason: string } {
	for (const rule of rules.bashToolPatterns ?? []) {
		try {
			if (new RegExp(rule.pattern).test(command)) {
				return {
					blocked: !rule.ask,
					ask: rule.ask ?? false,
					reason: rule.reason,
				};
			}
		} catch {}
	}
	return { blocked: false, ask: false, reason: "" };
}

function checkPathAccess(
	toolName: string,
	params: Record<string, unknown>,
	rules: DamageControlRules,
): string | null {
	const pathLike = (params.path ?? params.file_path ?? params.command ?? "") as string;
	if (!pathLike) return null;

	for (const pattern of rules.zeroAccessPaths ?? []) {
		if (pathLike.includes(pattern.replace(/\*/g, ""))) {
			return `Zero-access path blocked: ${pattern}`;
		}
	}

	if (["write", "edit"].includes(toolName)) {
		for (const pattern of rules.readOnlyPaths ?? []) {
			if (pathLike.includes(pattern.replace(/\*/g, ""))) {
				return `Read-only path: ${pattern}`;
			}
		}
	}

	if (toolName === "bash" && params.command) {
		const cmd = params.command as string;
		if (/\brm\b/.test(cmd)) {
			for (const pattern of rules.noDeletePaths ?? []) {
				if (cmd.includes(pattern.replace(/\*/g, ""))) {
					return `Deletion blocked for protected path: ${pattern}`;
				}
			}
		}
	}

	return null;
}

// ─── Context Hydration ────────────────────────────────────────────────────────

/** Gather repo context deterministically before running scout agents */
function gatherContext(cwd: string): string {
	const parts: string[] = [];

	// Git info
	try {
		const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
		const log = execSync("git log --oneline -10", { cwd, encoding: "utf-8" });
		const status = execSync("git status --short", { cwd, encoding: "utf-8" });
		parts.push(
			`## Git\nBranch: ${branch}\n\nRecent commits:\n${log.trim()}\n\nWorking tree:\n${status.trim() || "(clean)"}`,
		);
	} catch {}

	// README
	for (const name of ["README.md", "README.txt", "readme.md"]) {
		try {
			const content = readFileSync(join(cwd, name), "utf-8");
			parts.push(
				`## ${name}\n${content.slice(0, 2000)}${content.length > 2000 ? "\n…(truncated)" : ""}`,
			);
			break;
		} catch {}
	}

	// package.json
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		parts.push(
			`## package.json\n${JSON.stringify({ name: pkg.name, description: pkg.description, scripts: pkg.scripts }, null, 2)}`,
		);
	} catch {}

	return parts.length > 0 ? parts.join("\n\n---\n\n") : "";
}

/** Auto-detect lint command from project files */
function detectLintCommand(cwd: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		const s = pkg.scripts ?? {};
		if (s.lint) return "bun run lint";
		if (s["lint:check"]) return "bun run lint:check";
		if (s["type-check"]) return "bun run type-check";
	} catch {}
	if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
		return "bunx biome check .";
	}
	if (
		existsSync(join(cwd, ".eslintrc")) ||
		existsSync(join(cwd, ".eslintrc.json")) ||
		existsSync(join(cwd, ".eslintrc.js")) ||
		existsSync(join(cwd, "eslint.config.js")) ||
		existsSync(join(cwd, "eslint.config.mjs"))
	) {
		return "bunx eslint .";
	}
	return null;
}

/** Auto-detect test command from project files */
function detectTestCommand(cwd: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		const s = pkg.scripts ?? {};
		if (s.test && !s.test.includes("no test")) {
			const hasBunLock = existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"));
			return hasBunLock ? "bun test" : "npm test";
		}
		if (s["test:run"]) return "bun run test:run";
		if (s["test:ci"]) return "bun run test:ci";
	} catch {}
	if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) {
		return "pytest --tb=short";
	}
	return null;
}

// ─── Worktree Sandbox ─────────────────────────────────────────────────────────

/** Create an isolated git worktree branch for a pipeline run */
function createWorktree(
	cwd: string,
	runId: string,
): { path: string; branch: string; root: string } | null {
	const branch = `mintlet-run-${runId}`;
	const worktreeRoot = join(tmpdir(), branch);
	try {
		// Find the git repo root so we can compute the relative path of cwd inside it
		const gitRoot = execSync("git rev-parse --show-toplevel", { cwd }).toString().trim();
		execSync(`git worktree add -b "${branch}" "${worktreeRoot}" HEAD`, {
			cwd: gitRoot,
			stdio: "ignore",
		});
		// If cwd is a subdirectory of the git root, mirror that path inside the worktree
		const rel = cwd.startsWith(gitRoot) ? cwd.slice(gitRoot.length).replace(/^\//, "") : "";
		const path = rel ? join(worktreeRoot, rel) : worktreeRoot;
		return { path, branch, root: worktreeRoot };
	} catch {
		return null;
	}
}

/** Remove a git worktree and its branch */
function removeWorktree(cwd: string, worktreePath: string, branch: string): void {
	try {
		execSync(`git worktree remove --force "${worktreePath}"`, { cwd, stdio: "ignore" });
	} catch {}
	try {
		execSync(`git branch -D "${branch}"`, { cwd, stdio: "ignore" });
	} catch {}
}

// ─── Deterministic Node Runner ────────────────────────────────────────────────

/** Run a shell command directly (no LLM). Returns stdout+stderr, success flag, duration. */
function runDeterministicNode(
	command: string,
	nodeCwd: string,
	onProgress: (line: string) => void,
): Promise<{ success: boolean; output: string; duration: number }> {
	const start = Date.now();
	return new Promise((resolve) => {
		const proc = spawn("sh", ["-c", command], {
			cwd: nodeCwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const lines: string[] = [];
		const onData = (buf: Buffer) => {
			for (const line of buf.toString().split("\n")) {
				if (line.trim()) {
					lines.push(line);
					onProgress(line);
				}
			}
		};

		proc.stdout!.on("data", onData);
		proc.stderr!.on("data", onData);

		proc.on("close", (code) => {
			resolve({
				success: (code ?? 1) === 0,
				output: lines.join("\n"),
				duration: Date.now() - start,
			});
		});
		proc.on("error", (err) => {
			resolve({ success: false, output: err.message, duration: Date.now() - start });
		});
	});
}

// ─── Agent Loading ────────────────────────────────────────────────────────────

// Directory containing this extension file — used as fallback agent location
// when running mintlet from a project that has no local .pi/agents/mintlet/
const EXTENSION_REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function loadAgents(cwd: string): Map<string, AgentDef> {
	const agents = new Map<string, AgentDef>();
	// Prefer local project agents; fall back to the extension repo's own agents
	const localDir = join(cwd, ".pi", "agents", "mintlet");
	const globalDir = join(EXTENSION_REPO_DIR, ".pi", "agents", "mintlet");
	const mintletDir = existsSync(localDir) ? localDir : globalDir;

	if (!existsSync(mintletDir)) return agents;

	for (const file of readdirSync(mintletDir)) {
		if (!file.endsWith(".md")) continue;
		try {
			const raw = readFileSync(join(mintletDir, file), "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			if (!match) continue;
			const fm: Record<string, string> = {};
			for (const line of match[1].split("\n")) {
				const idx = line.indexOf(":");
				if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
			if (!fm.name) continue;
			agents.set(fm.name.toLowerCase(), {
				name: fm.name,
				description: fm.description ?? "",
				tools: fm.tools ?? "read,grep,find,ls",
				systemPrompt: match[2].trim(),
			});
		} catch {}
	}
	return agents;
}

// ─── Agent Subprocess ────────────────────────────────────────────────────────

function runAgentProcess(
	def: AgentDef,
	task: string,
	model: string,
	sessionFile: string,
	resumeSession: boolean,
	onProgress: (line: string) => void,
	agentCwd?: string,
): Promise<{ output: string; exitCode: number; elapsed: number }> {
	const args = [
		"--mode", "json",
		"-p",
		"--no-extensions",
		"--model", model,
		"--tools", def.tools,
		"--thinking", "off",
		"--append-system-prompt", def.systemPrompt,
		"--session", sessionFile,
	];
	if (resumeSession) args.push("-c");
	args.push(task);

	const textChunks: string[] = [];
	const startTime = Date.now();

	return new Promise((resolve) => {
		const proc = spawn("pi", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
			cwd: agentCwd,
		});

		let buffer = "";
		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_update") {
						const delta = ev.assistantMessageEvent;
						if (delta?.type === "text_delta" && delta.delta) {
							textChunks.push(delta.delta);
							onProgress(delta.delta);
						}
					}
				} catch {}
			}
		});
		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", () => {});

		proc.on("close", (code) => {
			resolve({
				output: textChunks.join(""),
				exitCode: code ?? 1,
				elapsed: Date.now() - startTime,
			});
		});
		proc.on("error", (err) => {
			resolve({
				output: `Spawn error: ${err.message}`,
				exitCode: 1,
				elapsed: Date.now() - startTime,
			});
		});
	});
}

// ─── Main Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// Sessions always live under the current project's .pi/ so each project
	// has its own agent memory even when the extension is loaded globally
	const sessionDir = join(cwd, ".pi", "agent-sessions", "mintlet");
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

	// State — agents are reloaded on each pipeline run so file changes take effect
	let agents = loadAgents(cwd);
	const damageRules = loadDamageRules(cwd);
	let phases: PhaseState[] = [];
	let pipelineActive = false;
	let widgetCtx: any = null;
	const agentSessions = new Map<string, string>(); // key → session file path
	const agentCards = new Map<string, AgentCardState>(); // widget card state per agent

	// ─── Damage Control Intercept ──────────────────────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = (event.input as any).command as string ?? "";

		const bashCheck = checkBashCommand(command, damageRules);
		if (bashCheck.blocked) {
			return {
				block: true,
				reason: `🛡 Mintlet blocked: ${bashCheck.reason}\nCommand: ${command}`,
			};
		}

		const pathBlock = checkPathAccess("bash", event.input as any, damageRules);
		if (pathBlock) {
			return { block: true, reason: `🛡 Mintlet blocked: ${pathBlock}` };
		}
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (isToolCallEventType("bash", event)) return;
		const toolName = (event as any).toolName ?? "";
		const args = (event as any).input ?? {};
		const pathBlock = checkPathAccess(toolName, args, damageRules);
		if (pathBlock) {
			return { block: true, reason: `🛡 Mintlet blocked: ${pathBlock}` };
		}
	});

	// ─── Widget (pi-pi card style) ────────────────────────────────────────

	function formatElapsed(ms: number): string {
		if (ms < 1000) return "";
		const s = Math.round(ms / 1000);
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
	}

	function renderCard(state: AgentCardState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusCol = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIco = state.status === "idle" ? "○"
			: state.status === "running" ? "◉"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(trunc(name, w)));
		const nameVisible = Math.min(name.length, w);

		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const queriesStr = state.queryCount > 0 ? ` (${state.queryCount})` : "";
		const statusRaw = `${statusIco} ${state.status}${timeStr}${queriesStr}`;
		const statusLine = theme.fg(statusCol, statusRaw);
		const statusVisible = statusRaw.length;

		const workRaw = state.task ? (state.lastLine || state.task) : state.def.description;
		const workText = trunc(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		const lastRaw = state.lastLine && state.task ? state.lastLine : "";
		const lastText = trunc(lastRaw, Math.min(50, w - 1));
		const lastLine = lastText ? theme.fg("dim", lastText) : theme.fg("dim", "—");
		const lastVisible = lastText ? lastText.length : 1;

		const colors = AGENT_COLORS[state.def.name.toLowerCase()];
		const bg  = colors?.bg ?? "";
		const br  = colors?.br ?? "";
		const bgr = bg ? BG_RESET : "";
		const fgr = br ? FG_RESET : "";

		const bord = (s: string) => bg + br + s + bgr + fgr;
		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) => {
			const pad = " ".repeat(Math.max(0, w - visLen));
			return bord("│") + bg + content + bg + pad + bgr + bord("│");
		};

		return [
			bord(top),
			border(" " + nameStr,   1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + workLine,  1 + workVisible),
			border(" " + lastLine,  1 + lastVisible),
			bord(bot),
		];
	}

	function initAgentCards() {
		agentCards.clear();
		for (const [key, def] of agents) {
			agentCards.set(key, {
				def, status: "idle", elapsed: 0,
				lastLine: "", task: "", queryCount: 0,
			});
		}
	}

	// Pipeline-order for card display: mirrors the execution order
	const PIPELINE_ORDER = ["scout", "planner", "builder", "reviewer", "tester", "playwright-tester", "committer"];

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("mintlet", (_tui: any, theme: any) => {
			return {
				render(width: number): string[] {
					// Sort agent cards by pipeline order; unknown agents go last
					const allCards = Array.from(agentCards.values());
					const cards = [
						...PIPELINE_ORDER
							.map(n => allCards.find(c => c.def.name.toLowerCase() === n))
							.filter(Boolean) as AgentCardState[],
						...allCards.filter(c => !PIPELINE_ORDER.includes(c.def.name.toLowerCase())),
					];

					const lines: string[] = [""];

					if (cards.length === 0) {
						lines.push(theme.fg("dim", "  No agents found in .pi/agents/mintlet/"));
					} else {
						const cols = Math.min(3, cards.length);
						const gap = 1;
						const colWidth = Math.floor((width - gap * (cols - 1)) / cols) - 1;

						for (let i = 0; i < cards.length; i += cols) {
							const row = cards.slice(i, i + cols);
							const cardLines = row.map((c) => renderCard(c, colWidth, theme));

							while (cardLines.length < cols) {
								cardLines.push(Array(6).fill(" ".repeat(colWidth)));
							}

							const height = cardLines[0].length;
							for (let l = 0; l < height; l++) {
								lines.push(cardLines.map((c) => c[l] ?? "").join(" ".repeat(gap)));
							}
						}
					}

					// Pipeline phase progress bar
					if (phases.length > 0) {
						lines.push("");
						const phaseItems = phases.map((p) => {
							const ico = statusIcon(p.status);
							const col = p.status === "running" ? "accent"
								: p.status === "done" ? "success"
								: p.status === "error" || p.status === "rejected" ? "error"
								: p.status === "skipped" ? "dim" : "dim";
							const label = p.retries > 0 ? `${p.label}(${p.retries})` : p.label;
							return theme.fg(col, `${ico} ${label}`);
						});
						// Wrap phases into rows of ~5
						const rowSize = 5;
						for (let i = 0; i < phaseItems.length; i += rowSize) {
							const row = phaseItems.slice(i, i + rowSize);
							lines.push("  " + row.join(theme.fg("dim", " → ")));
						}
					}

					return lines;
				},
				invalidate() {},
			};
		});
	}

	// ─── Pipeline Runner ───────────────────────────────────────────────────

	function getModel(_ctx: any): string {
		// Agents always run via claude-cli — they need Claude Code's built-in
		// bash/read/write tool loop. Using the orchestrator's provider here
		// would require passing API keys to subprocesses and breaks the design.
		return "claude-cli/claude-sonnet-4-6";
	}

	function sessionFor(key: string): { file: string; resume: boolean } {
		const file = join(sessionDir, `${key}.json`);
		const resume = agentSessions.has(key) && existsSync(file);
		return { file, resume };
	}

	async function runAgent(
		def: AgentDef,
		task: string,
		sessionKey: string,
		phase: PhaseState,
		model: string,
		agentCwd?: string,
	): Promise<{ output: string; exitCode: number }> {
		const cardKey = def.name.toLowerCase();
		const card = agentCards.get(cardKey);
		const startTime = Date.now();

		if (card) {
			card.status = "running";
			card.task = task.slice(0, 80);
			card.elapsed = 0;
			card.lastLine = "";
			card.queryCount++;
		}

		const elapsedTimer = setInterval(() => {
			if (card) { card.elapsed = Date.now() - startTime; updateWidget(); }
		}, 1000);

		const { file, resume } = sessionFor(sessionKey);
		const result = await runAgentProcess(def, task, model, file, resume, (delta) => {
			const line = delta.split("\n").filter((l) => l.trim()).pop() ?? "";
			if (card && line) { card.lastLine = line; }
			phase.lastWork = line || phase.lastWork;
			updateWidget();
		}, agentCwd);

		clearInterval(elapsedTimer);
		if (card) {
			card.status = result.exitCode === 0 ? "done" : "error";
			card.elapsed = Date.now() - startTime;
		}
		if (result.exitCode === 0) agentSessions.set(sessionKey, file);
		updateWidget();
		return result;
	}

	async function runPhaseAgents(
		agentName: string,
		count: number,
		tasks: string[],
		phaseState: PhaseState,
		model: string,
		agentCwd?: string,
	): Promise<string[]> {
		const def = agents.get(agentName.toLowerCase());
		if (!def) throw new Error(`Agent "${agentName}" not found in .pi/agents/mintlet/`);

		phaseState.status = "running";
		phaseState.agentNames = count === 1
			? [displayName(agentName)]
			: Array.from({ length: count }, (_, i) => `${displayName(agentName)} ${i + 1}`);

		const promises = Array.from({ length: count }, (_, i) => {
			const key = count === 1 ? agentName : `${agentName}-${i}`;
			const task = tasks[i] ?? tasks[0];
			return runAgent(def, task, key, phaseState, model, agentCwd);
		});

		const results = await Promise.all(promises);

		const failed = results.find((r) => r.exitCode !== 0);
		if (failed) {
			phaseState.status = "error";
			phaseState.lastWork = failed.output.slice(-200);
			updateWidget();
			throw new Error(failed.output);
		}

		phaseState.status = "done";
		updateWidget();
		return results.map((r) => r.output);
	}

	async function runPipelineFlow(
		task: string,
		opts: RunOptions,
		ctx: any,
	): Promise<{ success: boolean; summary: string }> {
		const {
			scouts = 1,
			builders = 1,
			reviewers = 1,
			testers = 1,
			skipCommit = false,
			maxReviewRetries = 3,
			maxTestRetries = 2,
			lintCommand: lintCmdOverride,
			testCommand: testCmdOverride,
			useWorktree = true,
		} = opts;

		const model = getModel(ctx);
		pipelineActive = true;

		// Reload agents from disk so tool changes take effect without restarting Pi
		agents = loadAgents(cwd);

		// Reset all agent cards to idle for the new run
		initAgentCards();

		// Auto-detect lint/test commands
		const resolvedLintCmd = lintCmdOverride ?? detectLintCommand(cwd);
		const resolvedTestCmd = testCmdOverride ?? detectTestCommand(cwd);

		// ── Initialise phase list ──────────────────────────────────────────
		const phaseList: PhaseState[] = [
			{ name: "context",  label: "Context",    agentNames: [], status: "pending", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "" },
			{ name: "scout",    label: "Scout",      agentNames: [], status: "pending", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "" },
			{ name: "plan",     label: "Plan",       agentNames: [], status: "pending", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "" },
			{ name: "worktree", label: "Worktree",   agentNames: [], status: useWorktree ? "pending" : "skipped", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "" },
			{ name: "build",    label: "Build",      agentNames: [], status: "pending", retries: 0, maxRetries: maxReviewRetries, elapsed: 0, lastWork: "" },
		];
		if (resolvedLintCmd) {
			phaseList.push({ name: "lint", label: "Lint", agentNames: [], status: "pending", retries: 0, maxRetries: 1, elapsed: 0, lastWork: "" });
		}
		phaseList.push(
			{ name: "review",   label: "Review",     agentNames: [], status: "pending", retries: 0, maxRetries: maxReviewRetries, elapsed: 0, lastWork: "" },
		);
		if (resolvedTestCmd) {
			phaseList.push({ name: "run-tests", label: "Run Tests", agentNames: [], status: "pending", retries: 0, maxRetries: maxTestRetries, elapsed: 0, lastWork: "" });
		}
		phaseList.push(
			{ name: "test",   label: "Test Gate", agentNames: [], status: "pending", retries: 0, maxRetries: maxTestRetries, elapsed: 0, lastWork: "" },
			{ name: "commit", label: "Commit+PR",  agentNames: [], status: skipCommit ? "skipped" : "pending", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "" },
		);
		phases = phaseList;
		updateWidget();

		const phaseOf = (name: string): PhaseState | undefined => phases.find((p) => p.name === name);

		// Phase timers
		const timers = new Map<string, ReturnType<typeof setInterval>>();
		function startTimer(name: string) {
			const p = phaseOf(name);
			if (!p) return;
			const t0 = Date.now();
			timers.set(name, setInterval(() => { p.elapsed = Date.now() - t0; updateWidget(); }, 1000));
		}
		function stopTimer(name: string) {
			clearInterval(timers.get(name));
			timers.delete(name);
		}

		let worktreeInfo: { path: string; branch: string } | null = null;

		try {
			// ── Phase 0: Gather context (deterministic) ────────────────────
			const contextPhase = phaseOf("context")!;
			contextPhase.status = "running";
			contextPhase.lastWork = "Gathering git log, README, package.json…";
			updateWidget();
			const repoContext = gatherContext(cwd);
			contextPhase.status = "done";
			contextPhase.lastWork = repoContext ? "Context ready" : "No context (not a git repo?)";
			updateWidget();

			// ── Phase 1: Scout ─────────────────────────────────────────────
			startTimer("scout");
			const contextPrefix = repoContext ? `## Repository Context\n${repoContext}\n\n` : "";
			const scoutTasks = Array.from({ length: scouts }, () =>
				`${contextPrefix}## Task\n${task}\n\nExplore the codebase to understand what needs to change. Focus on relevant files, existing patterns, and potential impact areas.`);
			const scoutOutputs = await runPhaseAgents("scout", scouts, scoutTasks, phaseOf("scout")!, model);
			const scoutReport = mergeOutputs(scoutOutputs, scoutOutputs.map((_, i) => `Scout ${i + 1}`));
			stopTimer("scout");

			// ── Phase 2: Plan ──────────────────────────────────────────────
			startTimer("plan");
			const planOutputs = await runPhaseAgents(
				"planner", 1,
				[`## Task\n${task}\n\n## Scout Findings\n${scoutReport}\n\nCreate a precise, step-by-step implementation plan.`],
				phaseOf("plan")!, model,
			);
			const plan = planOutputs[0];
			stopTimer("plan");

			// ── Worktree setup (deterministic) ─────────────────────────────
			const wtPhase = phaseOf("worktree");
			if (useWorktree && wtPhase) {
				startTimer("worktree");
				wtPhase.status = "running";
				wtPhase.lastWork = "Creating isolated branch…";
				updateWidget();
				const runId = Date.now().toString(36);
				worktreeInfo = createWorktree(cwd, runId);
				if (worktreeInfo) {
					wtPhase.status = "done";
					wtPhase.lastWork = `Branch: ${worktreeInfo.branch}`;
				} else {
					wtPhase.status = "skipped";
					wtPhase.lastWork = "git worktree unavailable — using main repo";
				}
				stopTimer("worktree");
				updateWidget();
			}

			const buildCwd = worktreeInfo?.path ?? cwd;

			// ── Phase 3+4+5: Build → Lint → Review loop ───────────────────
			let buildOutput = "";
			let reviewFeedback = "";
			let reviewApproved = false;

			for (let attempt = 0; attempt <= maxReviewRetries; attempt++) {
				// Build
				const buildPhase = phaseOf("build")!;
				buildPhase.status = "pending";
				buildPhase.retries = attempt;
				startTimer("build");

				const buildPrompt = attempt === 0
					? `## Task\n${task}\n\n## Plan\n${plan}\n\nImplement the plan. Work in the current directory.`
					: `## Task\n${task}\n\n## Plan\n${plan}\n\n## Reviewer Feedback (fix these issues)\n${reviewFeedback}\n\nFix all issues and re-implement.`;

				const buildOutputs = await runPhaseAgents(
					"builder", builders,
					Array.from({ length: builders }, () => buildPrompt),
					buildPhase, model, buildCwd,
				);
				buildOutput = mergeOutputs(buildOutputs, buildOutputs.map((_, i) => `Builder ${i + 1}`));
				stopTimer("build");

				// Lint (deterministic, optional)
				const lintPhase = phaseOf("lint");
				if (resolvedLintCmd && lintPhase) {
					lintPhase.status = "running";
					lintPhase.retries = attempt;
					startTimer("lint");

					const lintResult = await runDeterministicNode(resolvedLintCmd, buildCwd, (line) => {
						lintPhase.lastWork = line.slice(0, 120);
						updateWidget();
					});
					stopTimer("lint");

					if (!lintResult.success) {
						lintPhase.status = "rejected";
						lintPhase.lastWork = lintResult.output.split("\n").filter(Boolean).slice(-2).join(" | ");
						updateWidget();

						// One agentic lint-fix pass
						const builderDef = agents.get("builder");
						if (builderDef) {
							const fixPhase: PhaseState = {
								name: "lint-fix", label: "Lint Fix", agentNames: ["Builder"],
								status: "running", retries: 0, maxRetries: 1, elapsed: 0, lastWork: "",
							};
							await runAgent(
								builderDef,
								`## Lint Errors\n${lintResult.output.slice(0, 4000)}\n\n## Task\n${task}\n\nFix ALL lint errors listed above.`,
								`builder-lint-fix-${attempt}`,
								fixPhase, model, buildCwd,
							);
							// Verify lint is fixed
							const recheck = await runDeterministicNode(resolvedLintCmd, buildCwd, () => {});
							lintPhase.status = recheck.success ? "done" : "error";
							lintPhase.lastWork = recheck.success
								? "✓ Lint fixed"
								: recheck.output.split("\n").filter(Boolean).slice(-1)[0] ?? "Still failing";
							updateWidget();
						}
					} else {
						lintPhase.status = "done";
						lintPhase.lastWork = "✓ No lint errors";
						updateWidget();
					}
				}

				// Review
				const reviewPhase = phaseOf("review")!;
				reviewPhase.status = "pending";
				reviewPhase.retries = attempt;
				startTimer("review");

				const reviewOutputs = await runPhaseAgents(
					"reviewer", reviewers,
					Array.from({ length: reviewers }, () =>
						`## Task\n${task}\n\n## Implementation Summary\n${buildOutput}\n\nReview the changes in the codebase. End with APPROVED or REJECTED: <reason>.`),
					reviewPhase, model, buildCwd,
				);
				const reviewOutput = reviewOutputs[0];
				const reviewDecision = parseDecision(reviewOutput);
				stopTimer("review");

				if (reviewDecision.approved) {
					reviewApproved = true;
					reviewPhase.decision = "approved";
					break;
				}

				reviewFeedback = reviewDecision.reason;
				reviewPhase.status = "rejected";
				reviewPhase.decision = "rejected";
				reviewPhase.rejectionReason = reviewFeedback;
				updateWidget();

				if (attempt >= maxReviewRetries) {
					reviewPhase.status = "error";
					pipelineActive = false;
					return {
						success: false,
						summary: `Pipeline stopped: review rejected after ${maxReviewRetries + 1} attempts.\nLast rejection: ${reviewFeedback}`,
					};
				}
			}

			if (!reviewApproved) {
				pipelineActive = false;
				return { success: false, summary: "Review gate failed." };
			}

			// ── Phase 6+7: Run tests (deterministic) + Test gate loop ──────
			let testApproved = false;

			for (let attempt = 0; attempt <= maxTestRetries; attempt++) {
				let rawTestOutput = "";

				// Deterministic test run (optional)
				const runTestsPhase = phaseOf("run-tests");
				if (resolvedTestCmd && runTestsPhase) {
					runTestsPhase.status = "running";
					runTestsPhase.retries = attempt;
					startTimer("run-tests");

					const testResult = await runDeterministicNode(resolvedTestCmd, buildCwd, (line) => {
						runTestsPhase.lastWork = line.slice(0, 120);
						updateWidget();
					});
					stopTimer("run-tests");
					rawTestOutput = testResult.output;

					if (!testResult.success) {
						runTestsPhase.status = "rejected";
						runTestsPhase.lastWork = testResult.output.split("\n").filter(Boolean).slice(-2).join(" | ");
						updateWidget();

						// One agentic CI-fix pass (only if retries remain)
						if (attempt < maxTestRetries) {
							const builderDef = agents.get("builder");
							if (builderDef) {
								const fixPhase: PhaseState = {
									name: "ci-fix", label: "CI Fix", agentNames: ["Builder"],
									status: "running", retries: 0, maxRetries: 1, elapsed: 0, lastWork: "",
								};
								await runAgent(
									builderDef,
									`## Failing Tests\n${testResult.output.slice(0, 4000)}\n\n## Task\n${task}\n\nFix ALL failing tests.`,
									`builder-ci-fix-${attempt}`,
									fixPhase, model, buildCwd,
								);
								// Re-run tests after CI fix
								const retestResult = await runDeterministicNode(resolvedTestCmd, buildCwd, (line) => {
									runTestsPhase.lastWork = line.slice(0, 120);
									updateWidget();
								});
								rawTestOutput = retestResult.output;
								runTestsPhase.status = retestResult.success ? "done" : "error";
								runTestsPhase.lastWork = retestResult.success
									? "✓ Tests pass after CI fix"
									: retestResult.output.split("\n").filter(Boolean).slice(-1)[0] ?? "Still failing";
								updateWidget();
							}
						} else {
							runTestsPhase.status = "error";
							updateWidget();
						}
					} else {
						runTestsPhase.status = "done";
						runTestsPhase.lastWork = "✓ All tests pass";
						updateWidget();
					}
				}

				// Agentic test gate
				const testPhase = phaseOf("test")!;
				testPhase.status = "pending";
				testPhase.retries = attempt;
				startTimer("test");

				const testPrompt = rawTestOutput
					? `## Raw Test Output\n${rawTestOutput.slice(0, 4000)}\n\n## Task\n${task}\n\nVerify the implementation meets all requirements. End with APPROVED or REJECTED: <reason>.`
					: `## Task\n${task}\n\nRun tests and verify the implementation. End with APPROVED or REJECTED: <reason>.`;

				const testOutputs = await runPhaseAgents(
					"tester", testers,
					Array.from({ length: testers }, () => testPrompt),
					testPhase, model, buildCwd,
				);
				const testOutput = testOutputs[0];

				// Auto-spawn Playwright if flagged
				if (needsPlaywright(testOutput)) {
					const pwDef = agents.get("playwright-tester");
					if (pwDef) {
						testPhase.agentNames.push("Playwright");
						updateWidget();
						const { file, resume } = sessionFor("playwright-tester");
						const pwResult = await runAgentProcess(
							pwDef,
							`## Task\n${task}\n\nRun browser/UI tests. End with APPROVED or REJECTED: <reason>.`,
							model, file, resume,
							(delta) => {
								testPhase.lastWork = delta.split("\n").filter(Boolean).pop() ?? "";
								updateWidget();
							},
							buildCwd,
						);
						if (pwResult.exitCode === 0) agentSessions.set("playwright-tester", file);

						const pwDecision = parseDecision(pwResult.output);
						if (!pwDecision.approved) {
							testPhase.status = "rejected";
							testPhase.rejectionReason = `Playwright: ${pwDecision.reason}`;
							stopTimer("test");
							if (attempt >= maxTestRetries) break;
							continue;
						}
					}
				}

				const testDecision = parseDecision(testOutput);
				stopTimer("test");

				if (testDecision.approved) {
					testApproved = true;
					testPhase.decision = "approved";
					break;
				}

				testPhase.status = "rejected";
				testPhase.decision = "rejected";
				testPhase.rejectionReason = testDecision.reason;
				updateWidget();

				if (attempt >= maxTestRetries) {
					testPhase.status = "error";
					pipelineActive = false;
					return {
						success: false,
						summary: `Pipeline stopped: tests failed after ${maxTestRetries + 1} attempts.\nLast failure: ${testDecision.reason}`,
					};
				}
			}

			if (!testApproved) {
				pipelineActive = false;
				return { success: false, summary: "Test gate failed." };
			}

			// ── Phase 8: Commit + PR ───────────────────────────────────────
			if (!skipCommit) {
				startTimer("commit");
				const commitDef = agents.get("committer");
				const commitPhase = phaseOf("commit")!;

				if (!commitDef) {
					commitPhase.status = "skipped";
				} else {
					commitPhase.status = "pending";
					commitPhase.agentNames = ["Committer"];
					updateWidget();

					const { file, resume } = sessionFor("committer");
					const commitTask = worktreeInfo
						? `Commit the completed implementation and open a PR to main.\n\nTask: ${task}\n\nYou are in a git worktree on branch "${worktreeInfo.branch}". Run: git add -A && git commit -m "<message>" && git push -u origin ${worktreeInfo.branch} && gh pr create --base main --title "<title>" --body "<body>"`
						: `Commit the completed implementation and open a PR to main.\n\nTask: ${task}`;

					const commitResult = await runAgentProcess(
						commitDef, commitTask, model, file, resume,
						(delta) => {
							commitPhase.lastWork = delta.split("\n").filter(Boolean).pop() ?? "";
							updateWidget();
						},
						buildCwd,
					);
					stopTimer("commit");

					if (commitResult.exitCode === 0) {
						agentSessions.set("committer", file);
						commitPhase.status = "done";
					} else {
						commitPhase.status = "error";
						commitPhase.lastWork = commitResult.output.slice(-200);
					}
					updateWidget();
				}
			}

			pipelineActive = false;
			const finalPhase = skipCommit ? "test" : "commit";
			const finalStatus = phaseOf(finalPhase)?.status;
			const worktreeNote = worktreeInfo && skipCommit
				? `\nChanges in worktree: ${worktreeInfo.path} (branch: ${worktreeInfo.branch})`
				: "";
			return {
				success: finalStatus === "done" || finalStatus === "skipped",
				summary: `Pipeline complete ✓\nContext → Scout(${scouts}) → Plan → Build(${builders})${resolvedLintCmd ? " → Lint" : ""} → Review(${reviewers})${resolvedTestCmd ? " → Tests" : ""} → Test(${testers})${skipCommit ? " [no commit]" : " → Commit+PR"}${worktreeNote}`,
			};
		} catch (err) {
			pipelineActive = false;
			for (const timer of timers.values()) clearInterval(timer);
			const msg = err instanceof Error ? err.message : String(err);
			const runningPhase = phases.find((p) => p.status === "running");
			if (runningPhase) {
				runningPhase.status = "error";
				updateWidget();
			}
			return { success: false, summary: `Pipeline error: ${msg}` };
		} finally {
			// Always clean up the worktree after a committed run
			if (worktreeInfo && !skipCommit) {
				removeWorktree(cwd, worktreeInfo.root, worktreeInfo.branch);
			}
		}
	}

	// ─── Session Start ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		if (widgetCtx) widgetCtx.ui.setWidget("mintlet", undefined);
		widgetCtx = ctx;

		// Disable LLM tool routing — pipeline is triggered directly from user input
		// (works with any provider including claude-cli which can't call Pi custom tools)
		pi.setActiveTools([]);

		initAgentCards();

		const agentCount = agents.size;
		const dmgActive = Object.keys(damageRules).length > 0;
		ctx.ui.setStatus("mintlet", `Mintlet (${agentCount} agents${dmgActive ? " · 🛡" : ""})`);

		updateWidget();

		ctx.ui.notify(
			`Mintlet ready — ${agentCount} agents · /pipeline · /agents`,
			"info",
		);

		// Footer
		ctx.ui.setFooter((_tui: any, th: any, _footerData: any) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model?.id ?? "no-model";
				const usage = ctx.getContextUsage?.();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const runningPhase = phases.find((p) => p.status === "running");
				const mid = pipelineActive && runningPhase
					? th.fg("accent", ` ◉ ${runningPhase.label}`)
					: phases.length > 0 && !pipelineActive
					? th.fg("success", " ✓ done")
					: "";

				const dmgStr = dmgActive ? " 🛡" : "";
				const left = th.fg("dim", ` ${model}`) + th.fg("muted", " · ") + th.fg("accent", "Mintlet") + th.fg("dim", dmgStr);
				const right = th.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				return [truncateToWidth(left + mid + pad + right, width)];
			},
		}));
	});

	// ─── Tools ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "run_pipeline",
		label: "Run Pipeline",
		description:
			"Execute the Mintlet blueprint pipeline: Context → Scout → Plan → [Worktree] → Build → [Lint] → Review → [Tests] → Test Gate → Commit+PR. " +
			"Deterministic lint/test nodes run directly (no LLM). Failures trigger agentic fix passes. " +
			"All build/review/test work runs in an isolated git worktree branch.",
		parameters: Type.Object({
			task: Type.String({ description: "Full task description — what to implement" }),
			scouts: Type.Optional(Type.Number({ description: "Number of parallel scout agents (1-3, default 1)", minimum: 1, maximum: 3 })),
			builders: Type.Optional(Type.Number({ description: "Number of parallel builder agents (1-2, default 1)", minimum: 1, maximum: 2 })),
			reviewers: Type.Optional(Type.Number({ description: "Number of reviewer agents (default 1)", minimum: 1, maximum: 2 })),
			testers: Type.Optional(Type.Number({ description: "Number of tester agents (default 1)", minimum: 1, maximum: 2 })),
			skip_commit: Type.Optional(Type.Boolean({ description: "Skip the commit+PR step (default false)" })),
			lint_command: Type.Optional(Type.String({ description: "Override auto-detected lint command (e.g. 'bun run lint')" })),
			test_command: Type.Optional(Type.String({ description: "Override auto-detected test command (e.g. 'bun test')" })),
			use_worktree: Type.Optional(Type.Boolean({ description: "Create an isolated git worktree branch (default true)" })),
		}),

		async execute(_id, params, _signal, onUpdate, ctx) {
			const p = params as any;
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting Mintlet pipeline: ${p.task.slice(0, 80)}...` }],
					details: { status: "running" },
				});
			}

			// Reload agents before each run
			agents = loadAgents(cwd);

			const result = await runPipelineFlow(p.task, {
				scouts: p.scouts ?? 1,
				builders: p.builders ?? 1,
				reviewers: p.reviewers ?? 1,
				testers: p.testers ?? 1,
				skipCommit: p.skip_commit ?? false,
				lintCommand: p.lint_command,
				testCommand: p.test_command,
				useWorktree: p.use_worktree ?? true,
			}, ctx);

			return {
				content: [{ type: "text", text: result.summary }],
				details: { success: result.success, summary: result.summary },
			};
		},

		renderCall(args: any, th: any) {
			const task = (args?.task ?? "").slice(0, 60);
			const sc = args?.scouts ?? 1;
			const bl = args?.builders ?? 1;
			return new Text(
				th.fg("toolTitle", th.bold("run_pipeline ")) +
				th.fg("accent", `scouts:${sc} builders:${bl}`) +
				th.fg("dim", ` — ${task}${task.length >= 60 ? "…" : ""}`),
				0, 0,
			);
		},

		renderResult(result: any, _opts: any, th: any) {
			const details = result.details as any;
			const color = details?.success ? "success" : "warning";
			return new Text(
				th.fg(color, details?.summary ?? result.content?.[0]?.text ?? ""),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description:
			"Dispatch a single Mintlet agent for a focused ad-hoc task (outside the full pipeline). " +
			"Available: " + Array.from(agents.keys()).join(", "),
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (scout, planner, builder, reviewer, tester, committer)" }),
			task: Type.String({ description: "Task to give the agent" }),
		}),

		async execute(_id, params, _signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };
			agents = loadAgents(cwd); // reload so tool changes take effect without restarting Pi
			const def = agents.get(agent.toLowerCase());
			if (!def) {
				return {
					content: [{ type: "text", text: `Agent "${agent}" not found. Available: ${Array.from(agents.keys()).join(", ")}` }],
					details: {},
				};
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Dispatching ${displayName(agent)}…` }],
					details: { status: "running" },
				});
			}

			const model = getModel(ctx);
			const fakePhase: PhaseState = {
				name: agent, label: displayName(agent), agentNames: [displayName(agent)],
				status: "running", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "",
			};
			const result = await runAgent(def, task, agent, fakePhase, model);

			return {
				content: [{ type: "text", text: result.output }],
				details: { agent, exitCode: result.exitCode },
			};
		},

		renderCall(args: any, th: any) {
			const agent = args?.agent ?? "?";
			const task = (args?.task ?? "").slice(0, 55);
			return new Text(
				th.fg("toolTitle", th.bold("dispatch_agent ")) +
				th.fg("accent", displayName(agent)) +
				th.fg("dim", ` — ${task}${task.length >= 55 ? "…" : ""}`),
				0, 0,
			);
		},

		renderResult(result: any, _opts: any, th: any) {
			const text = result.content?.[0]?.text ?? "";
			const preview = text.split("\n").filter((l: string) => l.trim()).slice(-3).join(" · ");
			return new Text(th.fg("muted", truncateToWidth(preview || "done", 120)), 0, 0);
		},
	});

	pi.registerTool({
		name: "commit_and_pr",
		label: "Commit & PR",
		description: "Commit current changes to the current branch and open a PR to main. Use after work is approved.",
		parameters: Type.Object({
			title: Type.String({ description: "PR title" }),
			body: Type.Optional(Type.String({ description: "PR body / description" })),
		}),

		async execute(_id, params, _signal, onUpdate, ctx) {
			const { title, body } = params as { title: string; body?: string };
			const def = agents.get("committer");
			if (!def) {
				return {
					content: [{ type: "text", text: "Committer agent not found in .pi/agents/mintlet/" }],
					details: {},
				};
			}

			if (onUpdate) {
				onUpdate({ content: [{ type: "text", text: "Committing and opening PR…" }], details: {} });
			}

			const model = getModel(ctx);
			const { file, resume } = sessionFor("committer");
			const task = `Commit the current changes and open a PR.\nTitle: ${title}\nBody: ${body ?? title}`;
			const result = await runAgentProcess(def, task, model, file, resume, () => {});
			if (result.exitCode === 0) agentSessions.set("committer", file);

			return {
				content: [{ type: "text", text: result.output }],
				details: { exitCode: result.exitCode },
			};
		},

		renderCall(args: any, th: any) {
			return new Text(
				th.fg("toolTitle", th.bold("commit_and_pr ")) +
				th.fg("accent", args?.title ?? ""),
				0, 0,
			);
		},
	});

	// ─── Commands & Direct Input Routing ──────────────────────────────────
	//
	// Pipeline is triggered directly from user input — no LLM tool routing.
	// This works with any provider (including claude-cli) because we never
	// rely on the LLM to call a Pi-registered tool.

	pi.on("input", (event: any, ctx: any) => {
		const text = (event.text as string ?? "").trim();

		if (text === "/pipeline") {
			if (phases.length === 0) {
				ctx.ui.notify("No pipeline running. Type your task to start.", "info");
			} else {
				const lines = phases.map(
					(p) => `${statusIcon(p.status)} ${p.label.padEnd(14)} ${p.status}${p.rejectionReason ? ` — ${p.rejectionReason}` : ""}`,
				);
				ctx.ui.notify(`Pipeline status:\n${lines.join("\n")}`, "info");
			}
			return { handled: true };
		}

		if (text === "/agents") {
			const list = Array.from(agents.values())
				.map((a) => `  ${displayName(a.name).padEnd(20)} ${a.description}`)
				.join("\n");
			ctx.ui.notify(`Mintlet agents:\n${list || "(none found in .pi/agents/mintlet/)"}`, "info");
			return { handled: true };
		}

		// Any non-command input triggers the pipeline directly
		if (!text.startsWith("/") && text.length > 0) {
			if (pipelineActive) {
				ctx.ui.notify("Pipeline already running — please wait.", "warn");
				return { handled: true };
			}

			ctx.ui.notify(`Starting pipeline: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`, "info");

			runPipelineFlow(text, {}, ctx).then((result) => {
				ctx.ui.notify(result.summary, result.success ? "info" : "warn");
			}).catch((err: Error) => {
				ctx.ui.notify(`Pipeline error: ${err.message}`, "warn");
				pipelineActive = false;
				updateWidget();
			});

			return { handled: true };
		}
	});
}
