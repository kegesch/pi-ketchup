/**
 * pi-ketchup — LLM-powered guardrails for the pi coding agent
 *
 * Adapts the Ketchup guardrail engine (https://github.com/BeOnAuto/ketchup)
 * to pi's extension API. Maps Ketchup's Claude Code hooks to pi events:
 *
 *   Claude Code SessionStart  → pi "session_start" + "before_agent_start"
 *   Claude Code PreToolUse    → pi "tool_call"
 *   Claude Code UserPromptSubmit → pi "before_agent_start"
 *
 * Commit validation spawns `pi -p` as a subprocess (equivalent to how
 * Ketchup spawns `claude -p` for its validator sub-agent).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/brand.js";
import { initKetchup, formatInitResult } from "../src/init.js";
import { createHookState } from "../src/hook-state.js";
import { resolvePaths } from "../src/path-resolver.js";
import { loadDenyPatterns, isDenied } from "../src/deny-list.js";
import { loadReminders } from "../src/reminder-loader.js";
import { loadValidators } from "../src/validator-loader.js";
import { isValidatorSession } from "../src/validator-session.js";
import {
	isCommitCommand,
	getCommitContext,
	validateCommit,
	formatBlockMessage,
	type CommitContext,
	type CommitValidationResult,
} from "../src/commit-validator.js";
import { activityLog } from "../src/activity-logger.js";
import { debugLog } from "../src/debug-logger.js";
import {
	showConfig,
	listValidators,
	listReminders,
	toggleValidator,
	toggleReminder,
	setReminderPriority,
	addReminder,
	setConfigValue,
} from "../src/config-manager.js";

// Resolve the extension's own root directory
const EXTENSION_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

// Cached reminders to inject per-turn
let cachedReminders = "";

function isProtectedPath(filePath: string, validatorsDirs: string[]): boolean {
	return validatorsDirs.some((dir) => filePath.startsWith(`${dir}/`));
}

export default function ketchupExtension(pi: ExtensionAPI) {
	// ── Session Start ──────────────────────────────────────────────
	pi.on("session_start", async (event, ctx) => {
		const paths = resolvePaths(ctx.cwd, EXTENSION_ROOT);

		if (!fs.existsSync(paths.autoDir)) {
			// Not initialized yet — inject init hint as a reminder
			cachedReminders = `Reminder: Use /ketchup:init to enable ${BRAND.displayName} guardrails in this project.`;
			ctx.ui.notify(`Ketchup: run /ketchup:init to enable guardrails`, "info");
			return;
		}

		// Load SessionStart reminders
		const state = createHookState(paths.autoDir).read();
		const reminders = loadReminders(
			paths.remindersDirs,
			{ hook: "SessionStart" },
			state.overrides.reminders,
		);
		cachedReminders = reminders.map((r) => r.content).join("\n\n");

		activityLog(
			paths.autoDir,
			"",
			"session-start",
			`loaded ${reminders.length} reminders`,
		);
		debugLog(
			paths.autoDir,
			"session-start",
			`loaded ${reminders.length} reminders`,
		);
	});

	// ── Before Agent Start — inject reminders into context ─────────
	pi.on("before_agent_start", async (event, ctx) => {
		const paths = resolvePaths(ctx.cwd, EXTENSION_ROOT);
		if (!fs.existsSync(paths.autoDir)) return;

		// Skip reminder injection for validator sessions
		if (isValidatorSession(event.prompt)) return;

		// Load UserPromptSubmit reminders
		const state = createHookState(paths.autoDir).read();
		const userReminders = loadReminders(
			paths.remindersDirs,
			{ hook: "UserPromptSubmit" },
			state.overrides.reminders,
		);

		const allReminders = [
			cachedReminders,
			...userReminders.map((r) => r.content),
		]
			.filter(Boolean)
			.join("\n\n");

		if (!allReminders) return;

		activityLog(
			paths.autoDir,
			"",
			"before-agent-start",
			`injected ${userReminders.length + (cachedReminders ? 1 : 0)} reminders`,
		);

		return {
			message: {
				customType: "ketchup-reminders",
				content: allReminders,
				display: false,
			},
		};
	});

	// ── Tool Call — deny-list, protected paths, commit validation ──
	pi.on("tool_call", async (event, ctx) => {
		const paths = resolvePaths(ctx.cwd, EXTENSION_ROOT);

		if (!fs.existsSync(paths.autoDir)) return;

		// ── Deny-list + protected paths for file tools ──
		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = event.input.path as string;

			if (
				filePath &&
				isProtectedPath(filePath, paths.protectedValidatorsDirs)
			) {
				activityLog(
					paths.autoDir,
					"",
					"tool_call",
					`blocked protected: ${filePath}`,
				);
				return {
					block: true,
					reason: `Validator files are immutable: ${filePath}`,
				};
			}

			const state = createHookState(paths.autoDir).read();
			if (state.denyList.enabled) {
				const patterns = loadDenyPatterns(paths.autoDir);
				if (isDenied(filePath, patterns)) {
					activityLog(
						paths.autoDir,
						"",
						"tool_call",
						`blocked by deny-list: ${filePath}`,
					);
					return {
						block: true,
						reason: `Path ${filePath} is denied by ${BRAND.displayName} deny-list`,
					};
				}
			}
		}

		// ── Commit validation for bash tool ──
		if (event.toolName === "bash") {
			const command = event.input.command as string;

			// Check if command targets protected paths
			if (command) {
				for (const dir of paths.protectedValidatorsDirs) {
					if (command.includes(`${dir}/`)) {
						const idx = command.indexOf(`${dir}/`);
						const rest = command.slice(idx);
						const match = rest.match(/^(\S+)/);
						if (match) {
							activityLog(
								paths.autoDir,
								"",
								"tool_call",
								`blocked protected: ${match[1]}`,
							);
							return {
								block: true,
								reason: `Validator files are immutable: ${match[1]}`,
							};
						}
					}
				}
			}

			// Commit validation
			if (command && isCommitCommand(command)) {
				return await handleCommitValidation(paths, command, ctx.cwd);
			}
		}

		// ── PreToolUse reminders ──
		const state = createHookState(paths.autoDir).read();
		const preToolReminders = loadReminders(
			paths.remindersDirs,
			{
				hook: "PreToolUse",
				toolName: event.toolName,
			},
			state.overrides.reminders,
		);

		if (preToolReminders.length > 0) {
			// Inject reminder content as a message — can't modify input here,
			// but we can notify and the before_agent_start will inject next turn
			const content = preToolReminders.map((r) => r.content).join("\n\n");
			debugLog(
				paths.autoDir,
				"tool_call",
				`PreToolUse reminder for ${event.toolName}: ${content.slice(0, 100)}`,
			);
		}
	});

	// ── Commands ───────────────────────────────────────────────────

	pi.registerCommand("ketchup:init", {
		description: "Initialize Ketchup guardrails for this project",
		handler: async (_args, ctx) => {
			const result = initKetchup(ctx.cwd);
			const message = formatInitResult(result);
			ctx.ui.notify(message, "info");
		},
	});

	pi.registerCommand("ketchup:config", {
		description: "Manage Ketchup configuration (show, validators, reminders)",
		handler: async (args, ctx) => {
			const paths = resolvePaths(ctx.cwd, EXTENSION_ROOT);

			if (!fs.existsSync(paths.autoDir)) {
				ctx.ui.notify(
					"Ketchup is not initialized. Run /ketchup:init first.",
					"warning",
				);
				return;
			}

			const parts = (args || "").trim().split(/\s+/);
			const subcommand = parts[0];

			if (!subcommand || subcommand === "show") {
				const config = showConfig(paths);
				const lines: string[] = [
					"═══ Ketchup Configuration ═══",
					"",
					`Commit validation: ${config.state.validateCommit.mode}`,
					`Deny list: ${config.state.denyList.enabled ? "enabled" : "disabled"}`,
					`Prompt reminders: ${config.state.promptReminder.enabled ? "enabled" : "disabled"}`,
					"",
					"── Validators ──",
				];
				for (const v of config.validators) {
					const status = v.enabled ? "✓" : "✗";
					lines.push(
						`  ${status} ${v.name} — ${v.description}${v.overridden ? " (overridden)" : ""}`,
					);
				}
				lines.push("", "── Reminders ──");
				for (const r of config.reminders) {
					const status = r.enabled ? "✓" : "✗";
					lines.push(
						`  ${status} ${r.name} [${r.hook}] priority:${r.priority}${r.overridden ? " (overridden)" : ""}`,
					);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} else if (subcommand === "validators") {
				const action = parts[1];
				const name = parts[2];
				if (action === "disable" && name) {
					toggleValidator(paths, name, false);
					ctx.ui.notify(`Validator '${name}' disabled`, "info");
				} else if (action === "enable" && name) {
					toggleValidator(paths, name, true);
					ctx.ui.notify(`Validator '${name}' enabled`, "info");
				} else {
					const validators = listValidators(paths);
					const lines = validators.map(
						(v) => `${v.enabled ? "✓" : "✗"} ${v.name} — ${v.description}`,
					);
					ctx.ui.notify(lines.join("\n"), "info");
				}
			} else if (subcommand === "reminders") {
				const action = parts[1];
				if (action === "disable" && parts[2]) {
					toggleReminder(paths, parts[2], false);
					ctx.ui.notify(`Reminder '${parts[2]}' disabled`, "info");
				} else if (action === "enable" && parts[2]) {
					toggleReminder(paths, parts[2], true);
					ctx.ui.notify(`Reminder '${parts[2]}' enabled`, "info");
				} else if (action === "priority" && parts[2] && parts[3]) {
					setReminderPriority(paths, parts[2], Number(parts[3]));
					ctx.ui.notify(
						`Reminder '${parts[2]}' priority set to ${parts[3]}`,
						"info",
					);
				} else if (action === "add" && parts[2]) {
					const rest = parts.slice(4).join(" ");
					const filePath = addReminder(paths, parts[2], {
						hook: parts[3] !== "--content" ? parts[3] : undefined,
						content: rest || `Custom reminder: ${parts[2]}`,
					});
					ctx.ui.notify(`Reminder created: ${filePath}`, "info");
				} else {
					const reminders = listReminders(paths);
					const lines = reminders.map(
						(r) =>
							`${r.enabled ? "✓" : "✗"} ${r.name} [${r.hook}] priority:${r.priority}`,
					);
					ctx.ui.notify(lines.join("\n"), "info");
				}
			} else if (subcommand === "set" && parts[1]) {
				const keyPath = parts[1];
				const value = parts.slice(2).join(" ");
				if (!value) {
					ctx.ui.notify("Usage: /ketchup:config set <key> <value>", "warning");
					return;
				}
				setConfigValue(paths, keyPath, value);
				ctx.ui.notify(`Set ${keyPath} = ${value}`, "info");
			} else {
				ctx.ui.notify(
					[
						"Usage:",
						"  /ketchup:config show",
						"  /ketchup:config validators [enable|disable <name>]",
						"  /ketchup:config reminders [enable|disable <name> | priority <name> <n> | add <name> [hook] --content <text>]",
						"  /ketchup:config set <key.path> <value>",
					].join("\n"),
					"info",
				);
			}
		},
	});

	// ── Commit Validation Handler ──────────────────────────────────
	async function handleCommitValidation(
		paths: ReturnType<typeof resolvePaths>,
		command: string,
		cwd: string,
	): Promise<{ block: true; reason: string } | undefined> {
		const state = createHookState(paths.autoDir).read();

		if (state.validateCommit.mode === "off") {
			activityLog(paths.autoDir, "", "commit", "allowed (validation off)");
			return undefined;
		}

		const allValidators = loadValidators(
			paths.validatorsDirs,
			state.overrides.validators,
		);
		const validators = allValidators.filter((v) => v.name !== "appeal-system");

		if (validators.length === 0) {
			activityLog(paths.autoDir, "", "commit", "allowed (no validators)");
			return undefined;
		}

		let context: CommitContext;
		try {
			context = getCommitContext(cwd, command);
		} catch (err) {
			activityLog(
				paths.autoDir,
				"",
				"commit",
				`error getting commit context: ${String(err)}`,
			);
			// Can't get commit context — allow through
			return undefined;
		}

		const onLog = (event: string, name: string, detail?: string) => {
			activityLog(
				paths.autoDir,
				"",
				"commit",
				`validator ${event}: ${name} → ${detail ?? ""}`,
			);
		};

		const results = await validateCommit(
			validators,
			context,
			undefined, // use default spawnAsync
			onLog,
			state.validateCommit.batchCount,
		);

		const nacks = results.filter(
			(r: CommitValidationResult) => r.decision === "NACK",
		);

		if (nacks.length > 0) {
			const blockMessage = formatBlockMessage(results);
			activityLog(paths.autoDir, "", "commit", `blocked: ${blockMessage}`);
			debugLog(paths.autoDir, "commit", `blocked: ${blockMessage}`);

			if (state.validateCommit.mode === "warn") {
				// In warn mode, log but don't block
				pi.sendMessage({
					customType: "ketchup-warning",
					content: `⚠️ Ketchup commit validation warnings:\n${blockMessage}`,
					display: true,
				});
				return undefined;
			}

			return { block: true, reason: blockMessage };
		}

		activityLog(paths.autoDir, "", "commit", "allowed");
		debugLog(paths.autoDir, "commit", "allowed");
		return undefined;
	}
}
