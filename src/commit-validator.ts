import { execSync } from "node:child_process";
import type { Validator } from "./validator-loader.js";
import { runTier0Checkers, DEFAULT_HELPERS } from "./tier0-checker.js";
import type { TierModel } from "./model-router.js";

export function isCommitCommand(command: string): boolean {
	return /\bgit\s+commit\b/.test(command);
}

export interface CommitContext {
	diff: string;
	files: string[];
	message: string;
	/** Raw commit command — available to deterministic (tier-0) checkers. */
	command: string;
	/** Working dir — used to read staged file content (tier-0). */
	cwd: string;
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

	return { diff, files, message, command, cwd: gitCwd };
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

/**
 * SDK-based executor: creates a new pi agent session, sends the prompt,
 * and collects the full text response. Replaces the old subprocess spawn.
 */
async function sdkExecutor(prompt: string, model?: TierModel): Promise<string> {
	// Lazy-load the SDK so this module stays importable without the pi runtime
	// present (keeps validators unit-testable) and only pays the import cost when
	// a real model call actually runs.
	const { createAgentSession, SessionManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	// `model` is a structural view; the runtime object is a real Model from the
	// registry, so cast through `never` to satisfy the SDK's Model<any> param.
	const { session } = await createAgentSession({
		sessionManager: SessionManager.inMemory(),
		...(model ? { model: model as never } : {}),
	});

	// Collect streaming output
	let response = "";
	session.subscribe((event: any) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			response += event.assistantMessageEvent.delta;
		}
	});

	try {
		await session.prompt(prompt);
		await session.agent.waitForIdle();
	} finally {
		session.dispose();
	}

	return response;
}

export type Executor = (prompt: string) => Promise<string>;

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
	const jsonMatch = stdout.match(
		/\{[\s\S]*?"decision"\s*:\s*"(ACK|NACK)"[\s\S]*?\}/,
	);
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
			(r) => `${r.validator}: ${r.decision}${r.reason ? ` - ${r.reason}` : ""}`,
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
 * Run a single validator using the pi SDK.
 */
export async function runValidator(
	validator: Validator,
	context: CommitContext,
	executor: Executor = sdkExecutor,
): Promise<ValidatorResult> {
	const prompt = buildPrompt(validator, context);

	const first = await executor(prompt);
	const firstResult = parsePiJsonOutput(first);
	if (firstResult !== INVALID_RESPONSE) {
		return firstResult;
	}

	// Retry once on invalid response
	const second = await executor(prompt);
	return parsePiJsonOutput(second);
}

export async function runAppealValidator(
	appealValidator: Validator,
	context: CommitContext,
	results: CommitValidationResult[],
	appeal: string,
	executor: Executor = sdkExecutor,
): Promise<ValidatorResult> {
	const prompt = buildAppealPrompt(appealValidator, context, results, appeal);
	const response = await executor(prompt);

	return parsePiJsonOutput(response);
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

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Expected for non-JSON output; callers treat undefined/non-array as no match.
		return undefined;
	}
}

function extractJsonArray(raw: string): unknown[] | null {
	const direct = safeJsonParse(raw);
	if (Array.isArray(direct)) return direct;

	const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		const parsed = safeJsonParse(fenceMatch[1]);
		if (Array.isArray(parsed)) return parsed;
	}

	const bracketMatch = raw.match(/\[[\s\S]*\]/);
	if (bracketMatch) {
		const parsed = safeJsonParse(bracketMatch[0]);
		if (Array.isArray(parsed)) return parsed;
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

	const results: {
		validator: string;
		decision: "ACK" | "NACK";
		reason?: string;
	}[] = [];
	for (const name of validatorNames) {
		const entry = findEntryByName(parsed, name);
		if (!entry || !isValidDecision(entry.decision)) {
			results.push({
				validator: name,
				decision: "NACK",
				reason: "validator missing or invalid in batched response",
			});
		} else {
			const result: {
				validator: string;
				decision: "ACK" | "NACK";
				reason?: string;
			} = {
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

export interface TierModels {
	/** Small / local model for tier-1 validators. undefined = pi default. */
	tier1?: TierModel;
	/** Capable model for tier-2 validators. undefined = pi default. */
	tier2?: TierModel;
}

/**
 * Run all validators for a commit, routing each by its tier:
 *   - tier 0: deterministic code (no model, no tokens)
 *   - tier 1: configured small model (or pi default if unset)
 *   - tier 2: configured capable model (or pi default if unset)
 */
export async function validateCommit(
	validators: Validator[],
	context: CommitContext,
	onLog?: ValidatorLogger,
	batchCount: number = BATCH_COUNT,
	tierModels: TierModels = {},
	/** Test seam: override the LLM executor. Defaults to the real SDK executor. */
	executor?: (prompt: string, model?: TierModel) => Promise<string>,
): Promise<CommitValidationResult[]> {
	const tier0 = validators.filter((v) => v.tier === 0);
	const tier1 = validators.filter((v) => v.tier === 1);
	const tier2 = validators.filter(
		(v) => v.tier >= 2 || (!v.tier && v.tier !== 0),
	);

	const exec = executor ?? ((prompt, model) => sdkExecutor(prompt, model));
	const tier0Results = runTier0Chunk(tier0, context, onLog);
	const tier1Results = runTieredChunk(
		tier1,
		context,
		onLog,
		batchCount,
		tierModels.tier1,
		1,
		exec,
	);
	const tier2Results = runTieredChunk(
		tier2,
		context,
		onLog,
		batchCount,
		tierModels.tier2,
		2,
		exec,
	);

	const [t0, t1, t2] = await Promise.all([
		tier0Results,
		tier1Results,
		tier2Results,
	]);
	return [...t0, ...t1, ...t2];
}

/** Tier-0: deterministic checkers — synchronous, parallel, no model. */
function runTier0Chunk(
	validators: Validator[],
	context: CommitContext,
	onLog?: ValidatorLogger,
): CommitValidationResult[] {
	if (validators.length === 0) return [];
	const names = validators.map((v) => v.name);
	for (const name of names) {
		onLog?.("spawn", name, "tier-0 deterministic");
	}
	const results = runTier0Checkers(names, context, DEFAULT_HELPERS);
	return results.map((r) => {
		onLog?.(
			"complete",
			r.validator,
			`${r.decision}${r.reason ? `: ${r.reason}` : ""}`,
		);
		return {
			validator: r.validator,
			decision: r.decision,
			reason: r.reason,
			appealable: !NON_APPEALABLE_VALIDATORS.includes(r.validator),
		};
	});
}

/** Tier-1/2: batched LLM execution against the tier's configured model. */
async function runTieredChunk(
	validators: Validator[],
	context: CommitContext,
	onLog: ValidatorLogger | undefined,
	batchCount: number,
	model: TierModel | undefined,
	tier: 1 | 2,
	executor: (
		prompt: string,
		model?: TierModel,
	) => Promise<string> = sdkExecutor,
): Promise<CommitValidationResult[]> {
	if (validators.length === 0) return [];
	const chunks = chunkArray(validators, batchCount);

	const pending = chunks.map(async (chunk, chunkIndex) => {
		const names = chunk.map((v) => v.name);
		onLog?.(
			"spawn",
			`tier${tier}-batch-${chunkIndex}`,
			`validators: ${names.join(", ")}`,
		);

		try {
			const prompt = buildBatchedPrompt(chunk, context);
			const response = await executor(prompt, model);
			const batchResults = parseBatchedOutput(response, names);

			return batchResults.map((br): CommitValidationResult => {
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
			});
		} catch (err) {
			onLog?.("error", `tier${tier}-batch-${chunkIndex}`, String(err));
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
