// Verifies validateCommit's tier routing with an injectable executor:
//   - tier-0 validators resolve deterministically (executor NEVER called for them)
//   - tier-1 validators are sent to the tier-1 model
//   - tier-2 validators are sent to the tier-2 model
//   - untagged validators default to tier 2
// Run: npx tsx src/routing.selftest.ts
import { validateCommit } from "./commit-validator.js";
import type { Validator } from "./validator-loader.js";

function makeValidator(name: string, tier: number | undefined): Validator {
	return {
		name,
		description: name,
		enabled: true,
		tier: tier ?? 0,
		content: `rule ${name}`,
		path: `/${name}.md`,
	};
}

const context = {
	diff: "",
	files: [],
	message: "chore: x",
	command: "git commit -m 'chore: x'",
	cwd: ".",
};

const tier1Model = { id: "small-7b", name: "Small", provider: "ollama" };
const tier2Model = { id: "big-opus", name: "Big", provider: "anthropic" };

// Record every executor call: which validators + which model.
const calls: { modelId: string; validatorIds: string[] }[] = [];

async function fakeExecutor(prompt: string, model?: { id: string }) {
	const ids = [...prompt.matchAll(/<validator id="([^"]+)">/g)].map(
		(m) => m[1],
	);
	calls.push({
		modelId: model ? model.id : "(default)",
		validatorIds: ids,
	});
	return `[${ids.map((id) => `{"id":"${id}","decision":"ACK"}`).join(",")}]`;
}

async function main() {
	const validators = [
		// tier 0 — deterministic, must NOT hit the executor
		makeValidator("no-dangerous-git", 0),
		makeValidator("hygiene", 0),
		makeValidator("coverage-rules", 0),
		// tier 1 — must use tier1Model
		makeValidator("no-comments", 1),
		makeValidator("testing-no-mock-assertions", 1),
		// tier 2 — must use tier2Model
		makeValidator("dead-code", 2),
		makeValidator("burst-atomicity", 2),
		// untagged — must default to tier 2
		{
			...makeValidator("untagged", undefined),
			tier: undefined as unknown as number,
		},
	];

	const results = await validateCommit(
		validators,
		context,
		undefined,
		3, // batchCount
		{ tier1: tier1Model, tier2: tier2Model },
		fakeExecutor,
	);

	let pass = 0;
	let fail = 0;
	const assert = (cond: boolean, msg: string) => {
		if (cond) pass++;
		else {
			fail++;
			console.log(`  ✗ ${msg}`);
		}
	};

	// All validators resolved.
	assert(
		results.length === validators.length,
		`all ${validators.length} validators resolved (got ${results.length})`,
	);

	// Executor was never asked about a tier-0 validator.
	const tier0Names = ["no-dangerous-git", "hygiene", "coverage-rules"];
	const askedNames = calls.flatMap((c) => c.validatorIds);
	for (const n of tier0Names) {
		assert(!askedNames.includes(n), `tier-0 '${n}' never sent to executor`);
	}

	// Tier-1 / tier-2 validators went to the correct model.
	for (const c of calls) {
		for (const id of c.validatorIds) {
			if (["no-comments", "testing-no-mock-assertions"].includes(id)) {
				assert(
					c.modelId === tier1Model.id,
					`tier-1 '${id}' used ${c.modelId} (expected ${tier1Model.id})`,
				);
			}
			if (["dead-code", "burst-atomicity", "untagged"].includes(id)) {
				assert(
					c.modelId === tier2Model.id,
					`tier-2 '${id}' used ${c.modelId} (expected ${tier2Model.id})`,
				);
			}
		}
	}

	// Tier-0 results are deterministic ACKs (clean commit) — prove no model ran.
	const t0Results = results.filter((r) => tier0Names.includes(r.validator));
	assert(
		t0Results.every((r) => r.decision === "ACK"),
		"tier-0 deterministic results present and ACK",
	);

	console.log(`\nrouting smoke: ${pass} passed, ${fail} failed`);
	console.log(
		"executor calls:",
		calls.map((c) => `${c.modelId}→[${c.validatorIds.join(",")}]`).join("  "),
	);
	return fail;
}

main().then((fail) => process.exit(fail > 0 ? 1 : 0));
