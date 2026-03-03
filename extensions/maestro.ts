/**
 * Maestro — All-in-one conditional pipeline orchestrator
 *
 * Merges: damage control, task tracking (tilldone-style), multi-agent
 * dispatch (agent-team-style), and a conditional pipeline with
 * APPROVED/REJECTED gates and automatic retry/rerouting.
 *
 * Pipeline: Scout(s) → Planner → Builder(s) → Review Gate → Test Gate → Commit
 *
 *   Review gate: REJECTED → retry builders (up to 3×)
 *   Test gate:   REJECTED → retry from review (up to 2×)
 *   Playwright:  auto-spawned when tester output flags browser testing
 *
 * All features:
 *   ✓ Damage control  (bash safety rules from damage-control-rules.yaml)
 *   ✓ Task tracking   (live phase widget with status + retry counts)
 *   ✓ Parallel agents (multiple scouts, builders, reviewers, testers)
 *   ✓ Conditional routing (APPROVED / REJECTED gates between phases)
 *   ✓ Playwright auto-detection
 *   ✓ Commit + PR automation
 *   ✓ Primary orchestrator (delegates everything — never codes itself)
 *
 * Commands:
 *   /pipeline     — show current pipeline status
 *   /agents       — list loaded maestro agents
 *
 * Usage:  pi -e extensions/maestro.ts
 *         just ext-maestro
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parse as yamlParse } from "yaml";
import { applyExtensionDefaults } from "./themeMap.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
}

type PhaseStatus = "pending" | "running" | "done" | "error" | "rejected" | "skipped";

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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayName(name: string): string {
	return name
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
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
		// Stop scanning after non-empty non-decision line near end
		break;
	}
	// Scan further back for the decision line
	for (const line of lines) {
		const t = line.trim();
		if (/^APPROVED$/i.test(t)) return { approved: true, reason: "" };
		const rej = t.match(/^REJECTED:\s*(.+)$/i);
		if (rej) return { approved: false, reason: rej[1] };
	}
	// Default: assume approved if no explicit decision found
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

// ─── Agent Loading ────────────────────────────────────────────────────────────

function loadAgents(cwd: string): Map<string, AgentDef> {
	const agents = new Map<string, AgentDef>();
	const maestroDir = join(cwd, ".pi", "agents", "maestro");

	if (!existsSync(maestroDir)) return agents;

	for (const file of readdirSync(maestroDir)) {
		if (!file.endsWith(".md")) continue;
		try {
			const raw = readFileSync(join(maestroDir, file), "utf-8");
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

	// Directories
	const sessionDir = join(cwd, ".pi", "agent-sessions", "maestro");
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

	// State
	const agents = loadAgents(cwd);
	const damageRules = loadDamageRules(cwd);
	let phases: PhaseState[] = [];
	let pipelineActive = false;
	let widgetCtx: any = null;
	const agentSessions = new Map<string, string>(); // key → session file path

	// ─── Damage Control Intercept ──────────────────────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = (event.input as any).command as string ?? "";

		// Check bash patterns
		const bashCheck = checkBashCommand(command, damageRules);
		if (bashCheck.blocked) {
			return {
				block: true,
				reason: `🛡 Maestro blocked: ${bashCheck.reason}\nCommand: ${command}`,
			};
		}

		// Check path rules
		const pathBlock = checkPathAccess("bash", event.input as any, damageRules);
		if (pathBlock) {
			return { block: true, reason: `🛡 Maestro blocked: ${pathBlock}` };
		}
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (isToolCallEventType("bash", event)) return;
		const toolName = (event as any).toolName ?? "";
		const args = (event as any).input ?? {};
		const pathBlock = checkPathAccess(toolName, args, damageRules);
		if (pathBlock) {
			return { block: true, reason: `🛡 Maestro blocked: ${pathBlock}` };
		}
	});

	// ─── Widget ────────────────────────────────────────────────────────────

	function statusIcon(status: PhaseStatus): string {
		switch (status) {
			case "pending": return "○";
			case "running": return "⟳";
			case "done": return "✓";
			case "error": return "✗";
			case "rejected": return "↩";
			case "skipped": return "–";
		}
	}

	function formatElapsed(ms: number): string {
		if (ms < 1000) return "";
		const s = Math.round(ms / 1000);
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
	}

	function updateWidget() {
		if (!widgetCtx || phases.length === 0) return;

		const text = new Text("", 0, 0);
		widgetCtx.ui.setWidget("maestro", (_tui: any, th: any) => {
			return {
				render(width: number) {
					if (phases.length === 0) return "";

					const rows: string[] = [];
					const colW = [14, 22, 10, 10, 8];

					// Header
					const header = [
						truncateToWidth("Phase", colW[0]),
						truncateToWidth("Agents", colW[1]),
						truncateToWidth("Status", colW[2]),
						truncateToWidth("Retries", colW[3]),
						truncateToWidth("Time", colW[4]),
					]
						.map((c, i) => th.fg("dim", c.padEnd(colW[i])))
						.join("  ");
					rows.push(header);
					rows.push(th.fg("dim", "─".repeat(Math.min(width, 74))));

					for (const p of phases) {
						const icon = statusIcon(p.status);
						const iconColor =
							p.status === "done" ? "success"
							: p.status === "running" ? "accent"
							: p.status === "error" || p.status === "rejected" ? "warning"
							: "dim";

						const col0 = truncateToWidth(p.label, colW[0]).padEnd(colW[0]);
						const col1 = truncateToWidth(p.agentNames.join(", "), colW[1]).padEnd(colW[1]);
						const col2 = truncateToWidth(
							`${icon} ${p.status}`, colW[2],
						).padEnd(colW[2]);
						const col3 = (p.maxRetries > 0
							? `${p.retries}/${p.maxRetries}`
							: "").padEnd(colW[3]);
						const col4 = formatElapsed(p.elapsed).padEnd(colW[4]);

						let row = th.fg(iconColor, col0) + "  " +
							th.fg("muted", col1) + "  " +
							th.fg(iconColor, col2) + "  " +
							th.fg("dim", col3) + "  " +
							th.fg("dim", col4);

						// Show rejection reason inline
						if (p.status === "rejected" && p.rejectionReason) {
							const reason = truncateToWidth(`  ↳ ${p.rejectionReason}`, width - 2);
							row += "\n" + th.fg("warning", reason);
						}

						// Show last work for running phase
						if (p.status === "running" && p.lastWork) {
							const work = truncateToWidth(`  › ${p.lastWork}`, width - 2);
							row += "\n" + th.fg("dim", work);
						}

						rows.push(row);
					}

					return rows.join("\n");
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ─── Pipeline Runner ───────────────────────────────────────────────────

	function getModel(ctx: any): string {
		return ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "claude-cli/claude-sonnet-4-6";
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
	): Promise<{ output: string; exitCode: number }> {
		const { file, resume } = sessionFor(sessionKey);
		const result = await runAgentProcess(def, task, model, file, resume, (delta) => {
			const full = (phase.lastWork + delta).split("\n").filter((l) => l.trim()).pop() ?? "";
			phase.lastWork = full;
			updateWidget();
		});
		if (result.exitCode === 0) agentSessions.set(sessionKey, file);
		return result;
	}

	async function runPhaseAgents(
		agentName: string,
		count: number,
		tasks: string[],
		phaseState: PhaseState,
		model: string,
	): Promise<string[]> {
		const def = agents.get(agentName.toLowerCase());
		if (!def) throw new Error(`Agent "${agentName}" not found in .pi/agents/maestro/`);

		phaseState.status = "running";
		phaseState.agentNames = count === 1
			? [displayName(agentName)]
			: Array.from({ length: count }, (_, i) => `${displayName(agentName)} ${i + 1}`);
		updateWidget();

		const promises = Array.from({ length: count }, (_, i) => {
			const key = count === 1 ? agentName : `${agentName}-${i}`;
			const task = tasks[i] ?? tasks[0];
			return runAgent(def, task, key, phaseState, model);
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
		} = opts;

		const model = getModel(ctx);
		pipelineActive = true;

		// ── Initialise phase list ──────────────────────────────────────────
		phases = [
			{
				name: "scout", label: "Scout", agentNames: [],
				status: "pending", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "",
			},
			{
				name: "plan", label: "Plan", agentNames: [],
				status: "pending", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "",
			},
			{
				name: "build", label: "Build", agentNames: [],
				status: "pending", retries: 0, maxRetries: maxReviewRetries, elapsed: 0, lastWork: "",
			},
			{
				name: "review", label: "Review Gate", agentNames: [],
				status: "pending", retries: 0, maxRetries: maxReviewRetries, elapsed: 0, lastWork: "",
			},
			{
				name: "test", label: "Test Gate", agentNames: [],
				status: "pending", retries: 0, maxRetries: maxTestRetries, elapsed: 0, lastWork: "",
			},
			{
				name: "commit", label: "Commit + PR", agentNames: [],
				status: skipCommit ? "skipped" : "pending",
				retries: 0, maxRetries: 0, elapsed: 0, lastWork: "",
			},
		];
		updateWidget();

		const phaseOf = (name: string) => phases.find((p) => p.name === name)!;

		// Phase timers
		const timers = new Map<string, ReturnType<typeof setInterval>>();
		function startTimer(name: string) {
			const p = phaseOf(name);
			const t0 = Date.now();
			timers.set(name, setInterval(() => { p.elapsed = Date.now() - t0; updateWidget(); }, 1000));
		}
		function stopTimer(name: string) {
			clearInterval(timers.get(name));
			timers.delete(name);
		}

		try {
			// ── Phase 1: Scout ─────────────────────────────────────────────
			startTimer("scout");
			const scoutTasks = Array.from({ length: scouts }, () =>
				`Task: ${task}\n\nExplore the codebase to understand what needs to change.`);
			const scoutOutputs = await runPhaseAgents("scout", scouts, scoutTasks, phaseOf("scout"), model);
			const scoutReport = mergeOutputs(scoutOutputs, scoutOutputs.map((_, i) => `Scout ${i + 1}`));
			stopTimer("scout");

			// ── Phase 2: Plan ──────────────────────────────────────────────
			startTimer("plan");
			const planOutputs = await runPhaseAgents(
				"planner", 1,
				[`Task: ${task}\n\nScout findings:\n${scoutReport}\n\nCreate a precise implementation plan.`],
				phaseOf("plan"), model,
			);
			const plan = planOutputs[0];
			stopTimer("plan");

			// ── Phase 3+4: Build → Review loop ────────────────────────────
			let buildOutput = "";
			let reviewFeedback = "";
			let reviewApproved = false;

			for (let attempt = 0; attempt <= maxReviewRetries; attempt++) {
				// Build
				phaseOf("build").status = "pending";
				phaseOf("build").retries = attempt;
				startTimer("build");

				const buildPrompt = attempt === 0
					? `Task: ${task}\n\nPlan:\n${plan}\n\nImplement the plan.`
					: `Task: ${task}\n\nPrevious implementation was rejected.\nReviewer feedback: ${reviewFeedback}\n\nPlan:\n${plan}\n\nFix all issues and re-implement.`;

				const buildOutputs = await runPhaseAgents(
					"builder", builders,
					Array.from({ length: builders }, () => buildPrompt),
					phaseOf("build"), model,
				);
				buildOutput = mergeOutputs(buildOutputs, buildOutputs.map((_, i) => `Builder ${i + 1}`));
				stopTimer("build");

				// Review
				phaseOf("review").status = "pending";
				phaseOf("review").retries = attempt;
				startTimer("review");

				const reviewOutputs = await runPhaseAgents(
					"reviewer", reviewers,
					Array.from({ length: reviewers }, () =>
						`Task: ${task}\n\nImplementation summary:\n${buildOutput}\n\nReview the changes in the codebase. End with APPROVED or REJECTED: <reason>.`),
					phaseOf("review"), model,
				);
				const reviewOutput = reviewOutputs[0];
				const decision = parseDecision(reviewOutput);
				stopTimer("review");

				if (decision.approved) {
					reviewApproved = true;
					phaseOf("review").decision = "approved";
					break;
				}

				reviewFeedback = decision.reason;
				phaseOf("review").status = "rejected";
				phaseOf("review").decision = "rejected";
				phaseOf("review").rejectionReason = reviewFeedback;
				updateWidget();

				if (attempt >= maxReviewRetries) {
					phaseOf("review").status = "error";
					stopTimer("review");
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

			// ── Phase 5: Test → (optionally Playwright) loop ──────────────
			let testApproved = false;

			for (let attempt = 0; attempt <= maxTestRetries; attempt++) {
				phaseOf("test").status = "pending";
				phaseOf("test").retries = attempt;
				startTimer("test");

				const testOutputs = await runPhaseAgents(
					"tester", testers,
					Array.from({ length: testers }, () =>
						`Task: ${task}\n\nRun tests and verify the implementation. End with APPROVED or REJECTED: <reason>.`),
					phaseOf("test"), model,
				);
				const testOutput = testOutputs[0];

				// Auto-spawn Playwright if flagged
				if (needsPlaywright(testOutput)) {
					const pwDef = agents.get("playwright-tester");
					if (pwDef) {
						phaseOf("test").agentNames.push("Playwright");
						updateWidget();
						const { file, resume } = sessionFor("playwright-tester");
						const pwResult = await runAgentProcess(
							pwDef,
							`Task: ${task}\n\nRun browser/UI tests. End with APPROVED or REJECTED: <reason>.`,
							model, file, resume,
							(delta) => {
								phaseOf("test").lastWork = delta.split("\n").filter(Boolean).pop() ?? "";
								updateWidget();
							},
						);
						if (pwResult.exitCode === 0) agentSessions.set("playwright-tester", file);

						const pwDecision = parseDecision(pwResult.output);
						if (!pwDecision.approved) {
							phaseOf("test").status = "rejected";
							phaseOf("test").rejectionReason = `Playwright: ${pwDecision.reason}`;
							stopTimer("test");
							if (attempt >= maxTestRetries) break;
							// Retry loop goes back to build phase for a fix
							phaseOf("build").status = "pending";
							phaseOf("review").status = "pending";
							updateWidget();
							continue;
						}
					}
				}

				const decision = parseDecision(testOutput);
				stopTimer("test");

				if (decision.approved) {
					testApproved = true;
					phaseOf("test").decision = "approved";
					break;
				}

				phaseOf("test").status = "rejected";
				phaseOf("test").decision = "rejected";
				phaseOf("test").rejectionReason = decision.reason;
				updateWidget();

				if (attempt >= maxTestRetries) {
					phaseOf("test").status = "error";
					pipelineActive = false;
					return {
						success: false,
						summary: `Pipeline stopped: tests failed after ${maxTestRetries + 1} attempts.\nLast failure: ${decision.reason}`,
					};
				}
			}

			if (!testApproved) {
				pipelineActive = false;
				return { success: false, summary: "Test gate failed." };
			}

			// ── Phase 6: Commit + PR ───────────────────────────────────────
			if (!skipCommit) {
				startTimer("commit");
				const commitDef = agents.get("committer");
				if (!commitDef) {
					phaseOf("commit").status = "skipped";
				} else {
					phaseOf("commit").status = "pending";
					phaseOf("commit").agentNames = ["Committer"];
					updateWidget();

					const { file, resume } = sessionFor("committer");
					const commitResult = await runAgentProcess(
						commitDef,
						`Commit the completed implementation and open a PR to main.\n\nTask: ${task}`,
						model, file, resume,
						(delta) => {
							phaseOf("commit").lastWork = delta.split("\n").filter(Boolean).pop() ?? "";
							updateWidget();
						},
					);

					stopTimer("commit");

					if (commitResult.exitCode === 0) {
						agentSessions.set("committer", file);
						phaseOf("commit").status = "done";
					} else {
						phaseOf("commit").status = "error";
						phaseOf("commit").lastWork = commitResult.output.slice(-200);
					}
					updateWidget();
				}
			}

			pipelineActive = false;
			const finalPhase = skipCommit ? "test" : "commit";
			const finalStatus = phaseOf(finalPhase).status;
			return {
				success: finalStatus === "done" || finalStatus === "skipped",
				summary: `Pipeline complete ✓\nScout(${scouts}) → Plan → Build(${builders}) → Review(${reviewers}) → Test(${testers})${skipCommit ? "" : " → Commit"}`,
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
		}
	}

	// ─── Session Start ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		widgetCtx = ctx;

		// Lock down to orchestrator-only tools
		pi.setActiveTools(["run_pipeline", "dispatch_agent", "commit_and_pr"]);

		// Footer: model + damage control indicator + phase status
		ctx.ui.setFooter((_tui: any, th: any, width: number) => {
			const modelStr = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "no model";
			const phase = pipelineActive
				? (phases.find((p) => p.status === "running")?.label ?? "running")
				: "idle";
			const dmg = Object.keys(damageRules).length > 0 ? " 🛡" : "";
			const right = `${dmg} ${modelStr}`;
			const left = `Maestro › ${phase}`;
			const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
			return (
				th.fg("accent", left) +
				" ".repeat(gap) +
				th.fg("dim", right)
			);
		});
	});

	// ─── Tools ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "run_pipeline",
		label: "Run Pipeline",
		description:
			"Execute the Maestro conditional pipeline: Scout → Plan → Build → Review Gate → Test Gate → Commit+PR. " +
			"Review and test gates loop back on rejection. Playwright auto-launches for browser tests.",
		parameters: Type.Object({
			task: Type.String({ description: "Full task description — what to implement" }),
			scouts: Type.Optional(Type.Number({ description: "Number of parallel scout agents (1-3, default 1)", minimum: 1, maximum: 3 })),
			builders: Type.Optional(Type.Number({ description: "Number of parallel builder agents (1-2, default 1)", minimum: 1, maximum: 2 })),
			reviewers: Type.Optional(Type.Number({ description: "Number of reviewer agents (default 1)", minimum: 1, maximum: 2 })),
			testers: Type.Optional(Type.Number({ description: "Number of tester agents (default 1)", minimum: 1, maximum: 2 })),
			skip_commit: Type.Optional(Type.Boolean({ description: "Skip the commit+PR step (default false)" })),
		}),

		async execute(_id, params, _signal, onUpdate, ctx) {
			const p = params as any;
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting Maestro pipeline: ${p.task.slice(0, 80)}...` }],
					details: { status: "running" },
				});
			}

			const result = await runPipelineFlow(p.task, {
				scouts: p.scouts ?? 1,
				builders: p.builders ?? 1,
				reviewers: p.reviewers ?? 1,
				testers: p.testers ?? 1,
				skipCommit: p.skip_commit ?? false,
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
			"Dispatch a single Maestro agent for a focused ad-hoc task (outside the full pipeline). " +
			"Available: " + Array.from(agents.keys()).join(", "),
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (scout, planner, builder, reviewer, tester, committer)" }),
			task: Type.String({ description: "Task to give the agent" }),
		}),

		async execute(_id, params, _signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };
			const def = agents.get(agent.toLowerCase());
			if (!def) {
				return {
					content: [{ type: "text", text: `Agent "${agent}" not found. Available: ${Array.from(agents.keys()).join(", ")}` }],
					details: {},
				};
			}

			const phase: PhaseState = {
				name: agent, label: displayName(agent), agentNames: [displayName(agent)],
				status: "running", retries: 0, maxRetries: 0, elapsed: 0, lastWork: "",
			};

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Dispatching ${displayName(agent)}…` }],
					details: { status: "running" },
				});
			}

			const model = getModel(ctx);
			const { file, resume } = sessionFor(agent);
			const result = await runAgentProcess(def, task, model, file, resume, (delta) => {
				phase.lastWork = delta.split("\n").filter(Boolean).pop() ?? "";
			});

			if (result.exitCode === 0) agentSessions.set(agent, file);
			phase.status = result.exitCode === 0 ? "done" : "error";

			return {
				content: [{ type: "text", text: result.output }],
				details: { agent, exitCode: result.exitCode, elapsed: result.elapsed },
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
					content: [{ type: "text", text: "Committer agent not found in .pi/agents/maestro/" }],
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

	// ─── Commands ──────────────────────────────────────────────────────────

	pi.on("input", (event: any, ctx: any) => {
		if (event.text === "/pipeline") {
			if (phases.length === 0) {
				ctx.ui.notify("No pipeline has run yet. Use run_pipeline to start.", "info");
			} else {
				const lines = phases.map(
					(p) => `${statusIcon(p.status)} ${p.label.padEnd(14)} ${p.status}${p.rejectionReason ? ` — ${p.rejectionReason}` : ""}`,
				);
				ctx.ui.notify(`Pipeline status:\n${lines.join("\n")}`, "info");
			}
			return { handled: true };
		}

		if (event.text === "/agents") {
			const list = Array.from(agents.values())
				.map((a) => `  ${displayName(a.name).padEnd(20)} ${a.description}`)
				.join("\n");
			ctx.ui.notify(`Maestro agents:\n${list || "(none found in .pi/agents/maestro/)"}`, "info");
			return { handled: true };
		}
	});

	// ─── Orchestrator System Prompt ────────────────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		const agentList = Array.from(agents.values())
			.map((a) => `  - ${a.name}: ${a.description}`)
			.join("\n");

		return {
			systemPrompt: `You are the Maestro Orchestrator — the primary agent for this session.

Your role is to understand what the user wants and delegate ALL work to specialist agents.
You do NOT write code, run tests, or make file changes yourself.

## Your tools

- **run_pipeline(task, scouts?, builders?, reviewers?, testers?, skip_commit?)** — Run the full conditional pipeline:
    Scout(s) → Planner → Builder(s) → Review Gate (loops if rejected) → Test Gate (loops if rejected) → Commit+PR
    Use this for ANY coding, implementation, or feature task.

- **dispatch_agent(agent, task)** — Dispatch one agent for a focused ad-hoc task.
    Use for quick queries, single-step investigations, or tasks that don't need the full pipeline.

- **commit_and_pr(title, body?)** — Commit current changes and open a PR to main.
    Use when work is done but commit was skipped from the pipeline.

## Available agents
${agentList}

## When to use run_pipeline
- Feature implementation
- Bug fixes
- Refactoring
- Any task that touches code

## When to use dispatch_agent
- "What files handle X?" → dispatch scout
- "Explain this code" → dispatch scout
- "Quick plan for X" → dispatch planner

## Safety
Damage control rules are active. Dangerous bash commands and protected paths are automatically blocked.

## Starting a session
Greet the user briefly, confirm you're ready, and ask what they want to build.
Do NOT run the pipeline automatically — wait for the user's task description.`,
		};
	});
}
