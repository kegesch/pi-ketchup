// Verifies the provider-grouped selector helpers round-trip correctly.
// Run: npx tsx src/model-router.selftest.ts
import {
	groupByProvider,
	buildProviderOptions,
	parseProviderChoice,
	buildModelOptionsForProvider,
	parseModelIdChoice,
	DEFAULT_LABEL,
} from "./model-router.js";

let pass = 0;
let fail = 0;
const assert = (cond: boolean, msg: string) => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${msg}`);
	}
};

const models = [
	{ id: "opus", name: "Opus", provider: "anthropic" },
	{ id: "sonnet", name: "Sonnet", provider: "anthropic" },
	{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
	{ id: "qwen2.5-coder", name: "Qwen", provider: "ollama" },
];

const groups = groupByProvider(models);
assert(groups.length === 3, `3 providers, got ${groups.length}`);
assert(
	groups[0].provider === "anthropic",
	"providers sorted alphabetically (anthropic first)",
);
assert(groups[0].models.length === 2, "anthropic has 2 models");
assert(
	groups.find((g) => g.provider === "openai")!.models.length === 1,
	"openai has 1",
);

const providerOpts = buildProviderOptions(groups);
assert(providerOpts[0] === DEFAULT_LABEL, "default option first");
assert(providerOpts.includes("anthropic (2)"), "provider option shows count");

assert(parseProviderChoice(DEFAULT_LABEL) === null, "default → null");
assert(
	parseProviderChoice("anthropic (2)") === "anthropic",
	"provider choice → provider name",
);
assert(parseProviderChoice("ollama (1)") === "ollama", "ollama choice parsed");

const anthropicOpts = buildModelOptionsForProvider("anthropic", groups);
assert(anthropicOpts[0] === DEFAULT_LABEL, "model list: default first");
assert(anthropicOpts.includes("opus — Opus"), "model list includes opus");
assert(
	!anthropicOpts.includes("gpt-4o — GPT-4o"),
	"model list excludes other providers",
);

const ollamaOpts = buildModelOptionsForProvider("ollama", groups);
assert(
	ollamaOpts.length === 2 && ollamaOpts.includes("qwen2.5-coder — Qwen"),
	"ollama has default + 1 model",
);

assert(parseModelIdChoice(DEFAULT_LABEL) === null, "model default → null");
assert(parseModelIdChoice("opus — Opus") === "opus", "model choice → id");
assert(
	parseModelIdChoice("qwen2.5-coder:7b — Qwen Coder") === "qwen2.5-coder:7b",
	"model id with colon preserved",
);

// Unknown provider → only default
assert(
	buildModelOptionsForProvider("nonexistent", groups).length === 1,
	"unknown provider → just default",
);

console.log(`\nmodel-router smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
