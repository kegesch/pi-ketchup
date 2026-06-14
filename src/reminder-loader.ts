import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import type { ReminderOverride } from "./hook-state.js";

export interface ReminderWhen {
	hook?: string;
	mode?: string;
	toolName?: string;
	/**
	 * File extensions this reminder applies to (e.g. [".ts", ".tsx"]).
	 * When set, the reminder is NOT triggered by hooks. Instead it is only
	 * loaded when the agent reads a file whose extension matches one of these.
	 * This is an alternative to `hook`-based triggering.
	 */
	extensions?: string[];
	[key: string]: unknown;
}

export interface Reminder {
	name: string;
	when: ReminderWhen;
	priority: number;
	content: string;
	/** Convenience copy of `when.extensions` for display/filtering. */
	extensions?: string[];
}

export interface ReminderContext {
	hook: string;
	mode?: string;
	toolName?: string;
	/** File extension of the file being read (e.g. ".ts"), for extension-based reminders. */
	extension?: string;
	[key: string]: unknown;
}

/**
 * Normalize a single file extension to lowercase with a leading dot
 * (e.g. "TS" → ".ts", "ts" → ".ts", ".ts" → ".ts").
 */
export function normalizeExtension(ext: string): string {
	const trimmed = ext.trim().toLowerCase();
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** Normalize a list of extensions. */
export function normalizeExtensions(exts: string[]): string[] {
	return exts.map(normalizeExtension);
}

export function scanReminders(remindersDir: string): string[] {
	if (!fs.existsSync(remindersDir)) {
		return [];
	}

	return fs.readdirSync(remindersDir).filter((f) => f.endsWith(".md"));
}

export function parseReminder(content: string, filename: string): Reminder {
	const { data, content: body } = matter(content);
	const name = filename.replace(/\.md$/, "");
	const when = (data.when as ReminderWhen) || {};

	return {
		name,
		when,
		priority: (data.priority as number) || 0,
		content: body.trim(),
		extensions: Array.isArray(when.extensions)
			? normalizeExtensions(when.extensions)
			: undefined,
	};
}

export function matchReminders(
	reminders: Reminder[],
	context: ReminderContext,
): Reminder[] {
	return reminders.filter((reminder) => {
		const conditions = Object.entries(reminder.when).filter(
			([key]) => key !== "extensions",
		);
		const hasExtensions = Array.isArray(reminder.when.extensions);

		// No conditions of any kind → always match.
		if (conditions.length === 0 && !hasExtensions) {
			return true;
		}

		// Extension-based reminders require a matching file extension in the context.
		// Hook contexts (no `context.extension`) never match extension-based reminders,
		// so they are excluded from SessionStart / UserPromptSubmit / PreToolUse flows.
		if (hasExtensions) {
			const ctxExt = context.extension;
			if (!ctxExt) return false;
			const wanted = normalizeExtensions(reminder.when.extensions as string[]);
			if (!wanted.includes(ctxExt)) return false;
		}

		// Remaining conditions (hook, mode, toolName, …) use equality matching.
		return conditions.every(([key, value]) => context[key] === value);
	});
}

export function sortByPriority(reminders: Reminder[]): Reminder[] {
	return [...reminders].sort((a, b) => b.priority - a.priority);
}

export function loadReminders(
	dirs: string[],
	context: ReminderContext,
	overrides?: Record<string, ReminderOverride>,
): Reminder[] {
	const reminders = loadAllReminders(dirs, overrides);
	const matched = matchReminders(reminders, context);
	return sortByPriority(matched);
}

/**
 * Load reminders that apply to a given file extension.
 *
 * `fileExtension` should be normalized (lowercase, leading dot, e.g. ".ts").
 * Returns extension-based reminders whose `when.extensions` includes it,
 * sorted by priority. Hook-based reminders are excluded.
 */
export function loadRemindersForFileExtension(
	dirs: string[],
	fileExtension: string,
	overrides?: Record<string, ReminderOverride>,
): Reminder[] {
	const ext = normalizeExtension(fileExtension);
	return loadReminders(dirs, { hook: "", extension: ext }, overrides);
}

/**
 * Load and de-duplicate all enabled reminders from the given directories,
 * applying overrides. Shared by the hook-based and extension-based loaders.
 */
function loadAllReminders(
	dirs: string[],
	overrides?: Record<string, ReminderOverride>,
): Reminder[] {
	const reminders: Reminder[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		const filenames = scanReminders(dir);
		for (const filename of filenames) {
			if (seen.has(filename)) {
				continue;
			}
			seen.add(filename);
			const content = fs.readFileSync(path.join(dir, filename), "utf8");
			const reminder = parseReminder(content, filename);

			const override = overrides?.[reminder.name];
			if (override?.enabled === false) {
				continue;
			}
			if (override?.priority !== undefined) {
				reminder.priority = override.priority;
			}

			reminders.push(reminder);
		}
	}

	return reminders;
}
