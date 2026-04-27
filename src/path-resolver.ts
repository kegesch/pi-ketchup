import * as path from "node:path";
import { BRAND } from "./brand.js";

export interface ResolvedPaths {
	projectRoot: string;
	autoDir: string;
	extensionRoot: string;
	remindersDirs: string[];
	validatorsDirs: string[];
	protectedValidatorsDirs: string[];
}

/**
 * Resolve Ketchup paths for the pi environment.
 * Uses the extension's own directory instead of CLAUDE_PLUGIN_ROOT.
 */
export function resolvePaths(
	projectRoot: string,
	extensionRoot: string,
): ResolvedPaths {
	const autoDir = path.join(projectRoot, BRAND.dataDir);
	const pluginValidatorsDir = path.join(extensionRoot, "validators");

	return {
		projectRoot,
		autoDir,
		extensionRoot,
		remindersDirs: [
			path.join(extensionRoot, "reminders"),
			path.join(autoDir, "reminders"),
		],
		validatorsDirs: [pluginValidatorsDir, path.join(autoDir, "validators")],
		protectedValidatorsDirs: [pluginValidatorsDir],
	};
}
