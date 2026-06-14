// Smoke test for tier-0 deterministic checkers.
// Run: npx tsx src/tier0-checker.selftest.ts
import { runTier0Checkers, parseDiffAddedLines } from "./tier0-checker.js";
import type { CommitContext } from "./commit-validator.js";

interface Case {
	name: string;
	context: CommitContext;
	expect: "ACK" | "NACK";
}

function ctx(over: Partial<CommitContext>): CommitContext {
	return {
		diff: "",
		files: [],
		message: "chore: add thing",
		command: "git commit -m 'chore: add thing'",
		cwd: ".",
		...over,
	};
}

const cases: Case[] = [
	// no-dangerous-git
	{
		name: "no-dangerous-git",
		context: ctx({ command: "git commit --amend -m 'x'" }),
		expect: "NACK",
	},
	{
		name: "no-dangerous-git",
		context: ctx({ command: "git commit -m 'safe'" }),
		expect: "ACK",
	},
	// hygiene
	{
		name: "hygiene",
		context: ctx({ files: ["src/app.js"] }),
		expect: "NACK",
	},
	{
		name: "hygiene",
		context: ctx({ files: ["dist/bundle.js"], message: "chore: build" }),
		expect: "ACK",
	},
	{
		name: "hygiene",
		context: ctx({ message: "feat: add thing\n\nCo-Authored-By: Claude" }),
		expect: "NACK",
	},
	// coverage-rules
	{
		name: "coverage-rules",
		context: ctx({
			files: ["src/a.ts"],
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+const x: any = 1;\n",
		}),
		expect: "NACK",
	},
	{
		name: "coverage-rules",
		context: ctx({
			files: ["src/a.ts"],
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+const x: number = 1;\n",
		}),
		expect: "ACK",
	},
	{
		name: "coverage-rules",
		context: ctx({
			files: ["src/a.test.ts"],
			diff: "--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@\n+const x: any = mock;\n",
		}),
		expect: "ACK",
	},
	// type-organization
	{
		name: "type-organization",
		context: ctx({ files: ["src/types.ts"] }),
		expect: "NACK",
	},
	{
		name: "type-organization",
		context: ctx({ files: ["src/user.ts"] }),
		expect: "ACK",
	},
	// testing-weak-assertions
	{
		name: "testing-weak-assertions",
		context: ctx({
			files: ["a.test.ts"],
			diff: "--- a/a.test.ts\n+++ b/a.test.ts\n@@\n+expect(x).toBeTruthy();\n",
		}),
		expect: "NACK",
	},
	{
		name: "testing-weak-assertions",
		context: ctx({
			files: ["a.test.ts"],
			diff: "--- a/a.test.ts\n+++ b/a.test.ts\n@@\n+expect(x).toEqual({id:1});\n",
		}),
		expect: "ACK",
	},
	// infra-commit-format
	{
		name: "infra-commit-format",
		context: ctx({ files: ["package.json"], message: "feat: bump deps" }),
		expect: "NACK",
	},
	{
		name: "infra-commit-format",
		context: ctx({ files: ["package.json"], message: "chore(deps): bump" }),
		expect: "ACK",
	},
	// commit-message-no-speculation
	{
		name: "commit-message-no-speculation",
		context: ctx({ message: "fix: should work now" }),
		expect: "NACK",
	},
	{
		name: "commit-message-no-speculation",
		context: ctx({ message: "fix: handle null in parser" }),
		expect: "ACK",
	},
	// ketchup-plan-format — present + well-formed → ACK
	{
		name: "ketchup-plan-format",
		context: ctx({
			files: ["ketchup-plan.md"],
			message: "docs: plan",
		}),
		expect: "ACK", // readStagedFile returns null (not in a git repo) → ACK
	},
];

let pass = 0;
let fail = 0;
for (const c of cases) {
	const [result] = runTier0Checkers([c.name], c.context, {
		// Simulate "no staged file readable" → ketchup-plan ACKs safely.
		readStagedFile: () => null,
	});
	const ok = result.decision === c.expect;
	if (ok) {
		pass++;
	} else {
		fail++;
		console.log(
			`  ${ok ? "✓" : "✗"} ${c.name}: expected ${c.expect}, got ${result.decision}${result.reason ? ` — ${result.reason}` : ""}`,
		);
	}
}

// Extra: ketchup-plan-format with a readable, well-formed plan → ACK
const goodPlan = `## TODO\n- [ ] Burst 1: thing [depends: none]\n## DONE\n### Bottle: ThingMaker\n`;
const [goodRes] = runTier0Checkers(
	["ketchup-plan-format"],
	ctx({ files: ["ketchup-plan.md"] }),
	{
		readStagedFile: () => goodPlan,
	},
);
if (goodRes.decision === "ACK") pass++;
else {
	fail++;
	console.log(
		`  ✗ ketchup-plan (well-formed): got ${goodRes.decision} — ${goodRes.reason}`,
	);
}

// Extra: ketchup-plan-format missing TODO → NACK
const badPlan = `## DONE\n### Bottle: X\n`;
const [badRes] = runTier0Checkers(
	["ketchup-plan-format"],
	ctx({ files: ["ketchup-plan.md"] }),
	{
		readStagedFile: () => badPlan,
	},
);
if (badRes.decision === "NACK") pass++;
else {
	fail++;
	console.log(
		`  ✗ ketchup-plan (missing TODO): expected NACK, got ${badRes.decision}`,
	);
}

// parseDiffAddedLines sanity
const added = parseDiffAddedLines(
	"--- a/a.ts\n+++ b/a.ts\n@@\n const a = 1;\n+const b: any = 2;\n--- a/b.ts\n+++ b/b.ts\n@@\n+const c = 3;\n",
);
const okParse =
	added.get("a.ts")?.length === 1 && added.get("b.ts")?.length === 1;
if (okParse) pass++;
else {
	fail++;
	console.log(
		`  ✗ parseDiffAddedLines: ${JSON.stringify([...added.entries()])}`,
	);
}

console.log(`\ntier-0 smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
