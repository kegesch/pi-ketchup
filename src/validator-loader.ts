import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import type { ValidatorOverride } from "./hook-state.js";
import { DEFAULT_TIER } from "./model-router.js";

export interface Validator {
	name: string;
	description: string;
	enabled: boolean;
	/** Execution tier: 0 = deterministic JS, 1 = small model, 2 = capable model. */
	tier: number;
	content: string;
	path: string;
}

export interface ValidatorMeta {
	name: string;
	description: string;
	enabled: boolean;
	tier: number;
}

export function loadAllValidatorMeta(filePath: string): ValidatorMeta {
	const fileContent = fs.readFileSync(filePath, "utf8");
	const { data } = matter(fileContent);
	return {
		name: data.name as string,
		description: (data.description as string) || "",
		enabled: data.enabled !== false,
		tier: resolveTier(data.tier),
	};
}

/** Coerce a frontmatter `tier` value into a valid tier, defaulting safely. */
function resolveTier(raw: unknown): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (Number.isInteger(n) && n >= 0 && n <= 2) return n;
	return DEFAULT_TIER;
}

export function loadValidators(
	dirs: string[],
	overrides?: Record<string, ValidatorOverride>,
): Validator[] {
	const validators: Validator[] = [];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) {
			continue;
		}

		const files = fs.readdirSync(dir);
		for (const file of files) {
			if (!file.endsWith(".md")) {
				continue;
			}

			const filePath = path.join(dir, file);
			const fileContent = fs.readFileSync(filePath, "utf8");
			const { data, content } = matter(fileContent);

			const name = data.name as string;
			const override = overrides?.[name];
			const enabled =
				override !== undefined ? override.enabled : data.enabled !== false;

			if (!enabled) {
				continue;
			}

			validators.push({
				name,
				description: data.description,
				enabled: true,
				tier: resolveTier(data.tier),
				content: content.trim(),
				path: filePath,
			});
		}
	}

	return validators;
}
