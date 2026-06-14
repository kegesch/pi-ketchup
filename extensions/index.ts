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
 * Commit validation uses the pi SDK (`createAgentSession`) to run each
 * validator as an isolated LLM session (equivalent to how Ketchup spawns
 * `claude -p` for its validator sub-agent).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/brand.js";
import { initKetchup, formatInitResult } from "../src/init.js";
import { createHookState } from "../src/hook-state.js";
import { resolvePaths } from "../src/path-resolver.js";
import { loadDenyPatterns, isDenied } from "../src/deny-list.js";
import {
	loadReminders,
	loadRemindersForFileExtension,
} from "../src/reminder-loader.js";
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
import {
	resolveTierModels,
	formatModelLabel,
	groupByProvider,
	buildProviderOptions,
	parseProviderChoice,
	buildModelOptionsForProvider,
	parseModelIdChoice,
	MODEL_TIERS,
	DEFAULT_LABEL,
	type ModelCatalog,
} from "../src/model-router.js";
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

// Reminder names already injected this session via the file-extension path.
// Reset on every session_start so each session gets a fresh chance to surface
// them (e.g. after compaction clears them from context).
const injectedFileReminders = new Set<string>();

function isProtectedPath(filePath: string, validatorsDirs: string[]): boolean {
	return validatorsDirs.some((dir) => filePath.startsWith(`${dir}/`));
}

/** Format a reminder's trigger for display: file extensions if set, else hook. */
function formatReminderTrigger(r: {
	hook: string;
	extensions?: string[];
}): string {
	if (r.extensions && r.extensions.length > 0) {
		return `ext:${r.extensions.join(",")}`;
	}
	return r.hook;
}

export default function ketchupExtension(pi: ExtensionAPI) {
	// ── Session Start ──────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		// Fresh injection tracking for each session.
		injectedFileReminders.clear();

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
				return await handleCommitValidation(
					paths,
					command,
					ctx.cwd,
					ctx.modelRegistry,
				);
			}
		}

		// ── File-extension reminders (read tool) ──
		// Reminders whose frontmatter declares `when.extensions` are loaded
		// here instead of via hooks: they fire only when the agent reads a file
		// whose extension matches, and are injected as a steering message so
		// they land in context right after the read, before the next LLM call.
		if (event.toolName === "read") {
			const filePath = (event.input as { path?: string }).path;
			const ext = filePath ? path.extname(filePath).toLowerCase() : "";

			if (ext) {
				const fileState = createHookState(paths.autoDir).read();
				const fileReminders = loadRemindersForFileExtension(
					paths.remindersDirs,
					ext,
					fileState.overrides.reminders,
				).filter((r) => !injectedFileReminders.has(r.name));

				if (fileReminders.length > 0) {
					for (const r of fileReminders) {
						injectedFileReminders.add(r.name);
					}
					const content = fileReminders.map((r) => r.content).join("\n\n");
					pi.sendMessage(
						{
							customType: "ketchup-file-reminder",
							content,
							display: false,
						},
						{ deliverAs: "steer" },
					);
					activityLog(
						paths.autoDir,
						"",
						"tool_call",
						`injected ${fileReminders.length} file-extension reminder(s) for ${ext}`,
					);
					debugLog(
						paths.autoDir,
						"tool_call",
						`file-extension reminder for ${ext}: ${content.slice(0, 100)}`,
					);
				}
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
					"── Validators (tier: T0=deterministic, T1=small, T2=capable) ──",
				];
				for (const v of config.validators) {
					const status = v.enabled ? "✓" : "✗";
					lines.push(
						`  ${status} [T${v.tier}] ${v.name} — ${v.description}${v.overridden ? " (overridden)" : ""}`,
					);
				}
				lines.push("", "── Reminders ──");
				for (const r of config.reminders) {
					const status = r.enabled ? "✓" : "✗";
					lines.push(
						`  ${status} ${r.name} [${formatReminderTrigger(r)}] priority:${r.priority}${r.overridden ? " (overridden)" : ""}`,
					);
				}
				lines.push("", "── Models ──");
				lines.push(`  Tier 0 (deterministic): no model`);
				const t1 = config.state.models.tier1;
				const t2 = config.state.models.tier2;
				lines.push(
					`  Tier 1 (small/local):  ${t1 ? `${t1.provider}/${t1.id}` : "(pi default)"}`,
				);
				lines.push(
					`  Tier 2 (capable):      ${t2 ? `${t2.provider}/${t2.id}` : "(pi default)"}`,
				);
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
						(v) =>
							`${v.enabled ? "✓" : "✗"} [T${v.tier}] ${v.name} — ${v.description}`,
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
							`${r.enabled ? "✓" : "✗"} ${r.name} [${formatReminderTrigger(r)}] priority:${r.priority}`,
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
						"  /ketchup:models            configure per-tier models",
					].join("\n"),
					"info",
				);
			}
		},
	});

	// ── Models: per-tier model selection ─────────────────────────────
	pi.registerCommand("ketchup:models", {
		description: "Configure which model each validation tier uses",
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
			const hookState = createHookState(paths.autoDir);

			// `/ketchup:models show` — works without a UI.
			if (subcommand === "show" || (!ctx.hasUI && !subcommand)) {
				const { models } = hookState.read();
				const label = (ref: { provider: string; id: string } | null) =>
					ref ? `${ref.provider}/${ref.id}` : "(pi default)";
				ctx.ui.notify(
					[
						"── Ketchup tier models ──",
						`  Tier 0 (deterministic): no model`,
						`  Tier 1 (small/local):  ${label(models.tier1)}`,
						`  Tier 2 (capable):      ${label(models.tier2)}`,
					].join("\n"),
					"info",
				);
				return;
			}

			// Direct set/clear without UI: `/ketchup:models tier1 provider/id`
			if ((subcommand === "tier1" || subcommand === "tier2") && parts[1]) {
				const tier = subcommand as "tier1" | "tier2";
				if (parts[1] === "clear") {
					const state = hookState.read();
					state.models[tier] = null;
					hookState.write(state);
					ctx.ui.notify(`Tier ${tier[4]} reset to pi default`, "info");
					return;
				}
				const sep = parts[1].lastIndexOf("/");
				if (sep <= 0) {
					ctx.ui.notify(
						"Use the form: /ketchup:models tier1 provider/id",
						"warning",
					);
					return;
				}
				const provider = parts[1].slice(0, sep);
				const id = parts[1].slice(sep + 1);
				const state = hookState.read();
				state.models[tier] = { provider, id };
				hookState.write(state);
				ctx.ui.notify(`Tier ${tier[4]} → ${provider}/${id}`, "info");
				return;
			}

			// Interactive picker requires the TUI.
			if (!ctx.hasUI) {
				ctx.ui.notify(
					[
						"Interactive model selection needs the TUI.",
						"Set directly with: /ketchup:models tier1 provider/id",
						"Or clear with:    /ketchup:models tier1 clear",
						"Show current:    /ketchup:models show",
					].join("\n"),
					"info",
				);
				return;
			}

			const catalog: ModelCatalog = ctx.modelRegistry;
			const available = catalog.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify(
					"No models with configured auth found. Add a model/API key first.",
					"warning",
				);
				return;
			}

			// 1. Pick a tier (tier 0 is deterministic — no model).
			const selectableTiers = MODEL_TIERS.filter((t) => t.tier >= 1);
			const tierChoice = await ctx.ui.select(
				"Select a tier to configure",
				selectableTiers.map((t) => `${t.name} — ${t.description}`),
			);
			if (!tierChoice) return;
			const tierNum = Number(tierChoice.match(/Tier (\d)/)?.[1] ?? "2") as
				| 1
				| 2;
			const tier = tierNum === 1 ? "tier1" : "tier2";

			// Stage 2: provider. The generic selector has no scrolling viewport, so
			// we never dump the full catalog — pick a provider first (short list).
			const groups = groupByProvider(available);
			const providerChoice = await ctx.ui.select(
				`Tier ${tierNum} — select a provider`,
				buildProviderOptions(groups),
			);
			if (!providerChoice) return;
			const provider = parseProviderChoice(providerChoice);

			// "Use pi default" at the provider stage → clear the tier and stop.
			const state = hookState.read();
			if (!provider) {
				state.models[tier] = null;
				hookState.write(state);
				ctx.ui.notify(
					`Tier ${tierNum} → ${DEFAULT_LABEL.toLowerCase()}`,
					"info",
				);
				return;
			}

			// Stage 3: model within the chosen provider (short list).
			const modelChoice = await ctx.ui.select(
				`Tier ${tierNum} — ${provider} — select a model`,
				buildModelOptionsForProvider(provider, groups),
			);
			if (!modelChoice) return;
			const modelId = parseModelIdChoice(modelChoice);

			const ref = modelId ? { provider, id: modelId } : null;
			state.models[tier] = ref;
			hookState.write(state);

			if (ref) {
				ctx.ui.notify(
					`Tier ${tierNum} → ${formatModelLabel({
						id: ref.id,
						name: ref.id,
						provider: ref.provider,
					})}`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`Tier ${tierNum} → ${DEFAULT_LABEL.toLowerCase()}`,
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
		catalog?: ModelCatalog,
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

		// Resolve per-tier models from state.json against the live catalog.
		const tierModels =
			catalog !== undefined
				? resolveTierModels(state.models, catalog)
				: { tier1: undefined, tier2: undefined, missing: [] };
		if (tierModels.missing.length > 0) {
			pi.sendMessage({
				customType: "ketchup-warning",
				content: `⚠️ Ketchup could not resolve configured model(s): ${tierModels.missing.join(
					", ",
				)}. Falling back to the pi default for those tiers — run /ketchup:models to fix.`,
				display: true,
			});
		}

		const results = await validateCommit(
			validators,
			context,
			onLog,
			state.validateCommit.batchCount,
			{ tier1: tierModels.tier1, tier2: tierModels.tier2 },
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
