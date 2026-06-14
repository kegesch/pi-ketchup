/**
 * Model routing for tiered commit validation.
 *
 * Validators are tagged with a `tier` in their frontmatter:
 *   - tier 0: deterministic JS checker — no model, no tokens, fully reliable.
 *   - tier 1: small / local model for clear, low-reasoning pattern rules.
 *   - tier 2: capable model for genuinely semantic judgment.
 *
 * This module resolves each tier's configured model from the project's
 * state.json against the live model registry, and provides the catalog
 * formatting the `/ketchup:models` command needs for its selector.
 */

/** Structural shape of a model — enough to route and display. */
export interface TierModel {
	id: string;
	name: string;
	provider: string;
}

/** A model reference persisted to state.json (provider + id). */
export interface TierModelRef {
	provider: string;
	id: string;
}

/**
 * Minimal registry surface this module needs. The real
 * `ModelRegistry` from the SDK satisfies this structurally, and we stay
 * decoupled from the (non-top-level) `@earendil-works/pi-ai` types.
 */
export interface ModelCatalog {
	getAvailable(): TierModel[];
	find(provider: string, id: string): TierModel | undefined;
}

export const DEFAULT_TIER = 2;

export interface TierInfo {
	tier: 0 | 1 | 2;
	name: string;
	short: string;
	description: string;
}

/**
 * User-facing description of each tier. Tier 0 has no model — it runs
 * deterministic code — so it is deliberately absent from the model selector.
 */
export const MODEL_TIERS: TierInfo[] = [
	{
		tier: 0,
		name: "Tier 0",
		short: "T0",
		description: "Deterministic (no model) — fast, free, reliable",
	},
	{
		tier: 1,
		name: "Tier 1",
		short: "T1",
		description: "Small / local model for clear pattern rules",
	},
	{
		tier: 2,
		name: "Tier 2",
		short: "T2",
		description: "Capable model for semantic judgment",
	},
];

export interface TierModelsConfig {
	tier1: TierModelRef | null;
	tier2: TierModelRef | null;
}

/** `undefined` = use pi's default model; a resolved model = route to it. */
export interface ResolvedTierModels {
	tier1: TierModel | undefined;
	tier2: TierModel | undefined;
	/** human-readable names of configured-but-unresolvable models */
	missing: string[];
}

/**
 * Resolve configured tier models against the catalog.
 * Returns `undefined` for a tier when nothing is configured (caller falls
 * back to the SDK default) or when the configured model can't be found
 * (recorded in `missing` so the UI can warn).
 */
export function resolveTierModels(
	config: TierModelsConfig,
	catalog: ModelCatalog,
): ResolvedTierModels {
	const missing: string[] = [];

	const resolve = (ref: TierModelRef | null): TierModel | undefined => {
		if (!ref) return undefined;
		const model = catalog.find(ref.provider, ref.id);
		if (!model) {
			missing.push(`${ref.provider}/${ref.id}`);
			return undefined;
		}
		return model;
	};

	return {
		tier1: resolve(config.tier1),
		tier2: resolve(config.tier2),
		missing,
	};
}

/** `anthropic / claude-sonnet-4` — the label used in selectors and state. */
export function formatModelLabel(model: TierModel): string {
	return `${model.provider} / ${model.id}`;
}

/** Parse a selector choice back into a persisted reference. */
export function parseModelChoice(choice: string): TierModelRef | null {
	if (!choice || choice.startsWith("(") || choice === DEFAULT_LABEL) {
		return null;
	}
	// Selector entries are formatted as "provider / id — name"
	const core = choice.split(" — ")[0].trim();
	const slash = core.lastIndexOf(" / ");
	if (slash === -1) return null;
	return {
		provider: core.slice(0, slash).trim(),
		id: core.slice(slash + 3).trim(),
	};
}

export const DEFAULT_LABEL = "Use pi default model";

export interface ProviderGroup {
	provider: string;
	models: TierModel[];
}

/** Group available models by provider, sorted alphabetically. */
export function groupByProvider(models: TierModel[]): ProviderGroup[] {
	const map = new Map<string, TierModel[]>();
	for (const m of models) {
		const bucket = map.get(m.provider);
		if (bucket) bucket.push(m);
		else map.set(m.provider, [m]);
	}
	return [...map.entries()]
		.map(([provider, grouped]) => ({ provider, models: grouped }))
		.sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Provider options for stage 2: default + one line per provider (with count). */
export function buildProviderOptions(groups: ProviderGroup[]): string[] {
	return [
		DEFAULT_LABEL,
		...groups.map((g) => `${g.provider} (${g.models.length})`),
	];
}

/** Parse a provider-stage choice back into a provider name (null = default). */
export function parseProviderChoice(choice: string): string | null {
	if (!choice || choice === DEFAULT_LABEL) return null;
	return choice.replace(/\s*\(\d+\)\s*$/, "").trim();
}

/** Model options for stage 3 within a provider: default + that provider's models. */
export function buildModelOptionsForProvider(
	provider: string,
	groups: ProviderGroup[],
): string[] {
	const group = groups.find((g) => g.provider === provider);
	if (!group) return [DEFAULT_LABEL];
	return [DEFAULT_LABEL, ...group.models.map((m) => `${m.id} — ${m.name}`)];
}

/** Parse a model-stage choice back into a model id (null = default). */
export function parseModelIdChoice(choice: string): string | null {
	if (!choice || choice === DEFAULT_LABEL) return null;
	return choice.split(" — ")[0].trim();
}

/**
 * Build the option list for the model selector: every available model
 * formatted as "provider / id — name", prefixed by the default option.
 */
export function buildModelOptions(catalog: ModelCatalog): string[] {
	const models = catalog.getAvailable();
	const options = [DEFAULT_LABEL];
	for (const model of models) {
		options.push(`${formatModelLabel(model)} — ${model.name}`);
	}
	return options;
}
