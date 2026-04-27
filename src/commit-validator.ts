import { execSync, spawn } from "node:child_process";
import type { Validator } from "./validator-loader.js";

export interface SpawnResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

export function spawnAsync(
	cmd: string,
	args: string[],
	_options: { encoding: "utf8" },
): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", reject);
		child.on("close", (status) => {
			resolve({ stdout, stderr, status });
		});
	});
}

export function isCommitCommand(command: string): boolean {
	return /\bgit\s+commit\b/.test(command);
}

export interface CommitContext {
	diff: string;
	files: string[];
	message: string;
}

export function getCommitContext(cwd: string, command: string): CommitContext {
	const gitCwd = extractCdTarget(command) ?? cwd;
	const diff = execSync("git diff --cached", { cwd: gitCwd, encoding: "utf8" });
	const filesOutput = execSync("git diff --cached --name-only", {
		cwd: gitCwd,
		encoding: "utf8",
	});
	const files = filesOutput.trim().split("\n").filter(Boolean);
	const message = extractCommitMessage(command);

	return { diff, files, message };
}

export function extractCdTarget(command: string): string | null {
	const match = command.match(/^cd\s+(\S+)/);
	return match ? match[1] : null;
}

function extractCommitMessage(command: string): string {
	const match = command.match(/-m\s+["']([^"']+)["']/);
	return match ? match[1] : "";
}

export function extractAppeal(message: string): string | null {
	const match = message.match(/\[appeal:\s*([^\]]+)\]/);
	return match ? match[1].trim() : null;
}

export type Executor = (
	cmd: string,
	args: string[],
	options: { encoding: "utf8" },
) => SpawnResult | Promise<SpawnResult>;

export interface ValidatorResult {
	decision: "ACK" | "NACK";
	reason?: string;
	inputTokens?: number;
	outputTokens?: number;
}

const INVALID_RESPONSE: ValidatorResult = {
	decision: "NACK",
	reason: "validator returned invalid response (no ACK decision)",
};

export function parsePiJsonOutput(stdout: string): ValidatorResult {
	// pi -p outputs the assistant text directly (or JSON if --mode json)
	// Try JSON parse first
	try {
		const parsed = JSON.parse(stdout);
		if (parsed.decision === "ACK" || parsed.decision === "NACK") {
			return { decision: parsed.decision, reason: parsed.reason };
		}
	} catch {
		// Not pure JSON — try to extract JSON from the response
	}

	// Try to find JSON in the output (model may wrap it in text)
	const jsonMatch = stdout.match(/\{[\s\S]*?"decision"\s*:\s*"(ACK|NACK)"[\s\S]*?\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (parsed.decision === "ACK" || parsed.decision === "NACK") {
				return { decision: parsed.decision, reason: parsed.reason };
			}
		} catch {
			// fall through
		}
	}

	return INVALID_RESPONSE;
}

function buildPrompt(validator: Validator, context: CommitContext): string {
	return `<diff>
${context.diff}
</diff>

<commit-message>
${context.message}
</commit-message>

<files>
${context.files.join("\n")}
</files>

${validator.content}`;
}

function buildAppealPrompt(
	appealValidator: Validator,
	context: CommitContext,
	results: CommitValidationResult[],
	appeal: string,
): string {
	const resultsText = results
		.map(
			(r) =>
				`${r.validator}: ${r.decision}${r.reason ? ` - ${r.reason}` : ""}`,
		)
		.join("\n");

	return `<diff>
${context.diff}
</diff>

<commit-message>
${context.message}
</commit-message>

<files>
${context.files.join("\n")}
</files>

<validator-results>
${resultsText}
</validator-results>

<appeal>
${appeal}
</appeal>

${appealValidator.content}`;
}

/**
 * Run a single validator using `pi -p` as subprocess.
 */
export async function runValidator(
	validator: Validator,
	context: CommitContext,
	executor: Executor = spawnAsync,
): Promise<ValidatorResult> {
	const prompt = buildPrompt(validator, context);
	const args = ["-p", prompt];
	const opts = { encoding: "utf8" } as const;

	const first = await executor("pi", args, opts);
	const firstResult = parsePiJsonOutput(first.stdout);
	if (firstResult !== INVALID_RESPONSE) {
		return firstResult;
	}

	// Retry once on invalid response
	const second = await executor("pi", args, opts);
	return parsePiJsonOutput(second.stdout);
}

export async function runAppealValidator(
	appealValidator: Validator,
	context: CommitContext,
	results: CommitValidationResult[],
	appeal: string,
	executor: Executor = spawnAsync,
): Promise<ValidatorResult> {
	const prompt = buildAppealPrompt(
		appealValidator,
		context,
		results,
		appeal,
	);
	const result = await executor("pi", ["-p", prompt], {
		encoding: "utf8",
	});

	return parsePiJsonOutput(result.stdout);
}

const NON_APPEALABLE_VALIDATORS = ["no-dangerous-git"];

export interface CommitValidationResult {
	validator: string;
	decision: "ACK" | "NACK";
	reason?: string;
	appealable: boolean;
}

export type ValidatorLogger = (
	event: "spawn" | "complete" | "error",
	validatorName: string,
	detail?: string,
) => void;

const BATCH_COUNT = 3;

function stripValidatorBoilerplate(content: string): string {
	return content
		.replace(/^You are a commit validator\.[^\n]*\n*/m, "")
		.replace(
			/\n*Valid responses:\n\{"decision":"ACK"\}\n\{"decision":"NACK","reason":"[^"]*"\}\n*/m,
			"",
		)
		.replace(/\n*RESPOND WITH JSON ONLY[^\n]*/m, "")
		.trim();
}

function buildBatchedPrompt(
	validators: Validator[],
	context: CommitContext,
): string {
	const rulesSection = validators
		.map(
			(v) =>
				`<validator id="${v.name}">
${stripValidatorBoilerplate(v.content)}
</validator>`,
		)
		.join("\n\n");

	return `You are a commit validator evaluating a commit against multiple rule sets. Respond with a JSON array — one entry per validator with its id, decision (ACK/NACK), and reason if NACK.

<diff>
${context.diff}
</diff>

<commit-message>
${context.message}
</commit-message>

<files>
${context.files.join("\n")}
</files>

${rulesSection}

Respond with ONLY a JSON array:
[{"id":"<validator-id>","decision":"ACK"},{"id":"<validator-id>","decision":"NACK","reason":"one sentence"}]`;
}

function chunkArray<T>(arr: T[], count: number): T[][] {
	const chunks: T[][] = [];
	const size = Math.ceil(arr.length / count);
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}

function extractJsonArray(raw: string): unknown[] | null {
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		/* */
	}

	const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		try {
			const parsed = JSON.parse(fenceMatch[1]);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			/* */
		}
	}

	const bracketMatch = raw.match(/\[[\s\S]*\]/);
	if (bracketMatch) {
		try {
			const parsed = JSON.parse(bracketMatch[0]);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			/* */
		}
	}

	return null;
}

function isValidDecision(value: unknown): value is "ACK" | "NACK" {
	return value === "ACK" || value === "NACK";
}

function findEntryByName(
	arr: unknown[],
	name: string,
): Record<string, unknown> | undefined {
	for (const item of arr) {
		if (typeof item === "object" && item !== null) {
			const obj = item as Record<string, unknown>;
			if (obj.id === name || obj.validator === name) return obj;
		}
	}
	return undefined;
}

export function parseBatchedOutput(
	stdout: string,
	validatorNames: string[],
): { validator: string; decision: "ACK" | "NACK"; reason?: string }[] {
	const parsed = extractJsonArray(stdout);

	if (!parsed) {
		const nack: "NACK" = "NACK";
		return validatorNames.map((name) => ({
			validator: name,
			decision: nack,
			reason: "batched validator returned unparseable response",
		}));
	}

	const results: { validator: string; decision: "ACK" | "NACK"; reason?: string }[] = [];
	for (const name of validatorNames) {
		const entry = findEntryByName(parsed, name);
		if (!entry || !isValidDecision(entry.decision)) {
			results.push({
				validator: name,
				decision: "NACK",
				reason: "validator missing or invalid in batched response",
			});
		} else {
			const result: { validator: string; decision: "ACK" | "NACK"; reason?: string } = {
				validator: name,
				decision: entry.decision,
			};
			if (typeof entry.reason === "string") {
				result.reason = entry.reason;
			}
			results.push(result);
		}
	}
	return results;
}

export async function validateCommit(
	validators: Validator[],
	context: CommitContext,
	executor: Executor = spawnAsync,
	onLog?: ValidatorLogger,
	batchCount: number = BATCH_COUNT,
): Promise<CommitValidationResult[]> {
	const chunks = chunkArray(validators, batchCount);

	const pending = chunks.map(async (chunk, chunkIndex) => {
		const names = chunk.map((v) => v.name);
		onLog?.("spawn", `batch-${chunkIndex}`, `validators: ${names.join(", ")}`);

		try {
			const prompt = buildBatchedPrompt(chunk, context);
			const spawnResult = await executor("pi", ["-p", prompt], {
				encoding: "utf8",
			});
			const batchResults = parseBatchedOutput(spawnResult.stdout, names);

			const commitResults: CommitValidationResult[] = batchResults.map(
				(br) => {
					onLog?.(
						"complete",
						br.validator,
						`${br.decision}${br.reason ? `: ${br.reason}` : ""}`,
					);
					return {
						validator: br.validator,
						decision: br.decision,
						reason: br.reason,
						appealable: !NON_APPEALABLE_VALIDATORS.includes(br.validator),
					};
				},
			);

			return commitResults;
		} catch (err) {
			onLog?.("error", `batch-${chunkIndex}`, String(err));
			return chunk.map((v) => ({
				validator: v.name,
				decision: "NACK" as const,
				reason: `validator crashed: ${String(err)}`,
				appealable: false,
			}));
		}
	});

	const batchResults = await Promise.all(pending);
	return batchResults.flat();
}

export function formatBlockMessage(results: CommitValidationResult[]): string {
	const nacks = results.filter((r) => r.decision === "NACK");
	const lines: string[] = [];

	for (const nack of nacks) {
		lines.push(`${nack.validator}: ${nack.reason}`);
	}

	const hasNonAppealable = nacks.some((r) => !r.appealable);
	const hasAppealable = nacks.some((r) => r.appealable);

	if (hasNonAppealable) {
		lines.push("");
		lines.push("This violation cannot be appealed.");
	}

	if (hasAppealable) {
		lines.push("");
		lines.push(
			"To appeal, add [appeal: your justification] to your commit message.",
		);
	}

	return lines.join("\n");
}
