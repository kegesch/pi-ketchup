/**
 * Tier-0 deterministic validators.
 *
 * These eight rules need no LLM: they are substring / regex / filename /
 * message-structure checks. Running them as code is faster, free, and
 * perfectly reliable (no ACK/NACK flakiness). Each mirrors the intent of
 * its markdown counterpart in `validators/` — when a markdown rule says
 * "NACK if the diff contains X", this is the X check.
 *
 * Every function is pure (the only side-effecting input is an injectable
 * `readStagedFile` used by ketchup-plan-format), so the module is trivially
 * unit-testable.
 */
import { execSync } from "node:child_process";
import type { CommitContext } from "./commit-validator.js";

export interface CheckerResult {
  decision: "ACK" | "NACK";
  reason?: string;
}

export type Tier0Checker = (
  context: CommitContext,
  helpers: Tier0Helpers,
) => CheckerResult;

export interface Tier0Helpers {
  /** Read a path from the git index (staged content). Returns null if absent. */
  readStagedFile: (relPath: string) => string | null;
}

export const DEFAULT_HELPERS: Tier0Helpers = {
  readStagedFile: (relPath) => {
    try {
      return execSync(`git show :${relPath}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  },
};

/** Registry of tier-0 rule name → checker. Mirrors validator filenames. */
export const TIER0_CHECKERS: Record<string, Tier0Checker> = {
  "no-dangerous-git": checkNoDangerousGit,
  hygiene: checkHygiene,
  "coverage-rules": checkCoverageRules,
  "type-organization": checkTypeOrganization,
  "testing-weak-assertions": checkTestingWeakAssertions,
  "infra-commit-format": checkInfraCommitFormat,
  "commit-message-no-speculation": checkCommitMessageNoSpeculation,
  "ketchup-plan-format": checkKetchupPlanFormat,
};

/**
 * Run the tier-0 subset of validators deterministically.
 * Returns one result per requested validator name; unknown names NACK with
 * a clear reason so misconfiguration surfaces instead of silently passing.
 */
export function runTier0Checkers(
  names: string[],
  context: CommitContext,
  helpers: Tier0Helpers = DEFAULT_HELPERS,
): { validator: string; decision: "ACK" | "NACK"; reason?: string }[] {
  return names.map((name) => {
    const checker = TIER0_CHECKERS[name];
    if (!checker) {
      return {
        validator: name,
        decision: "NACK",
        reason: `tier-0 checker '${name}' is not implemented`,
      };
    }
    const result = checker(context, helpers);
    return {
      validator: name,
      decision: result.decision,
      reason: result.reason,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Diff parsing helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a unified diff into per-file added-line buckets.
 * Returns a map of file path → array of added lines (without the leading `+`).
 */
export function parseDiffAddedLines(diff: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string | null = null;
  let currentAdded: string[] = [];

  const flush = () => {
    if (current !== null) result.set(current, currentAdded);
    current = null;
    currentAdded = [];
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      continue;
    }
    if (line.startsWith("+++ ")) {
      flush();
      // "+++ b/path" — strip the leading "b/"
      current = line.slice(4).replace(/^b\//, "");
      if (current === "/dev/null") current = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (current !== null && line.startsWith("+") && !line.startsWith("+++")) {
      currentAdded.push(line.slice(1));
    }
  }
  flush();
  return result;
}

const TS_EXT = /\.(ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;
const JS_EXT = /\.(js|jsx)$/;

function isBarrelIndex(file: string): boolean {
  return /(^|\/)index\.(ts|tsx)$/.test(file);
}

function isTypeFile(file: string): boolean {
  const base = file.split("/").pop() ?? "";
  if (/^(types|interfaces)\.(ts|tsx)$/.test(base)) return true;
  if (/^types\//.test(file) || /\/types\//.test(file)) return true;
  if (/^interfaces\//.test(file) || /\/interfaces\//.test(file)) return true;
  return false;
}

const nack = (reason: string): CheckerResult => ({ decision: "NACK", reason });
const ack = (): CheckerResult => ({ decision: "ACK" });

// ────────────────────────────────────────────────────────────────────────────
// Individual checkers
// ────────────────────────────────────────────────────────────────────────────

/** `no-dangerous-git`: block dangerous flags on the commit command itself. */
function checkNoDangerousGit(context: CommitContext): CheckerResult {
  const command = context.command ?? "";
  // `--no-verify` would normally skip the hook, but check defensively.
  const dangerous: RegExp[] = [
    /--no-verify\b/,
    /--force\b/,
    /--force-with-lease\b/,
    /\s-f\b/,
    /--amend\b/,
    /reset\s+--hard\b/,
  ];
  for (const re of dangerous) {
    if (re.test(command)) {
      return nack(`commit command uses a forbidden git flag (${re.source})`);
    }
  }
  return ack();
}

/** `hygiene`: no .js outside dist/, no AI attribution in the message. */
function checkHygiene(context: CommitContext): CheckerResult {
  for (const file of context.files) {
    if (
      JS_EXT.test(file) &&
      !file.startsWith("dist/") &&
      !file.includes("/dist/")
    ) {
      return nack(
        `.js file outside dist/ is not allowed: ${file} (source should be .ts)`,
      );
    }
  }

  const msg = context.message;
  const attribution = [
    /co-authored-by:[^\n]*claude/i,
    /generated with claude/i,
    /generated by claude/i,
    /\bclaude\b/i,
    /generated with (?:a\.?i\.?|gpt|copilot|gemini|llm)/i,
    /generated by (?:a\.?i\.?|gpt|copilot|gemini|llm)/i,
  ];
  for (const re of attribution) {
    if (re.test(msg)) {
      return nack("commit message contains AI/LLM attribution");
    }
  }
  return ack();
}

/** `coverage-rules`: forbid type escape hatches in source .ts/.tsx. */
function checkCoverageRules(context: CommitContext): CheckerResult {
  const addedByFile = parseDiffAddedLines(context.diff);

  for (const [file, lines] of addedByFile) {
    if (!TS_EXT.test(file)) continue;
    if (TEST_FILE.test(file)) continue; // tests are exempt
    if (isBarrelIndex(file)) continue; // barrel re-exports are exempt

    for (const line of lines) {
      // ts-ignore / ts-expect-error pragmas (escape hatches)
      if (/@ts-ignore|@ts-expect-error/.test(line)) {
        return nack(`ts-ignore/ts-expect-error escape hatch in ${file}`);
      }
      // coverage-ignore pragmas
      if (/\/\*\s*(istanbul|c8|v8)\s+ignore/.test(line)) {
        return nack(`coverage-ignore pragma in ${file}`);
      }
      // `any` type usage (conservative type-context match)
      if (/(^|[^A-Za-z0-9_$])any(?=[\s,>;)[\]=]|$)/.test(line)) {
        return nack(`'any' type annotation in ${file}`);
      }
      // double-cast / unsafe casts
      if (/\bas\s+unknown\s+as\b/.test(line)) {
        return nack(`'as unknown as' cast in ${file}`);
      }
    }
  }
  return ack();
}

/** `type-organization`: no standalone types.ts / interfaces.ts / types/ dir. */
function checkTypeOrganization(context: CommitContext): CheckerResult {
  for (const file of context.files) {
    if (isTypeFile(file)) {
      return nack(
        `standalone type file '${file}' — define types inline where used`,
      );
    }
  }
  return ack();
}

/** `testing-weak-assertions`: forbid weak matchers in test files. */
function checkTestingWeakAssertions(context: CommitContext): CheckerResult {
  const addedByFile = parseDiffAddedLines(context.diff);
  const weak = [
    /\.toBeDefined\(\)/,
    /\.toBeTruthy\(\)/,
    /\.toBeFalsy\(\)/,
    /\.not\.toBeNull\(\)/,
    /\.not\.toBeUndefined\(\)/,
    /\.toBeGreaterThan\(0\)/,
  ];

  for (const [file, lines] of addedByFile) {
    if (!TEST_FILE.test(file)) continue;
    for (const line of lines) {
      for (const re of weak) {
        if (re.test(line)) {
          return nack(`weak assertion ${re.source} in ${file}`);
        }
      }
    }
  }
  return ack();
}

const CONFIG_FILE =
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|\w+\.config\.(ts|js|mts|cjs|mjs)|wrangler\.toml|\.gitignore|\.npmignore|\.eslintrc.*|\.prettierrc.*|\.editorconfig|ketchup-plan\.md|.*\.lock|.*\.toml|.*\.ya?ml|.*\.json)$/;

const CONFIG_DIR = /^(\.claude|\.github|\.vscode|\.idea)\//;

function isConfigFile(file: string): boolean {
  if (CONFIG_DIR.test(file)) return true;
  return CONFIG_FILE.test(file);
}

/** `infra-commit-format`: config-only commits must use `chore:`. */
function checkInfraCommitFormat(context: CommitContext): CheckerResult {
  if (context.files.length === 0) return ack();

  // If any behavioral source file is present, this validator doesn't apply.
  const hasBehavioral = context.files.some(
    (f) => TS_EXT.test(f) && !/\.(config)\.(ts|js)$/.test(f),
  );
  if (hasBehavioral) return ack();

  const allConfig = context.files.every(isConfigFile);
  if (!allConfig) return ack();

  const subject = context.message.split("\n")[0].trim();
  if (/^(feat|fix|test|build|ci|refactor|perf)(\(.+\))?:/.test(subject)) {
    if (!/^chore(\(.+\))?:/.test(subject)) {
      return nack(
        `config-only commit should use 'chore:' not '${subject.split(":")[0]}:'`,
      );
    }
  }
  return ack();
}

const SPECULATION_PHRASES = [
  "should work",
  "should pass",
  "should fix",
  "should be fine",
  "probably",
  "seems to",
  "seems fine",
  "i think",
  "might work",
  "might fix",
  "maybe",
  "hopefully",
  "fingers crossed",
  "let's see",
  "let's try",
  "trying this",
  "try this",
  "not sure if",
  "not 100%",
  "uncertain",
  "untested but",
];

/** `commit-message-no-speculation`: block hedging language in messages. */
function checkCommitMessageNoSpeculation(
  context: CommitContext,
): CheckerResult {
  const lower = context.message.toLowerCase();
  for (const phrase of SPECULATION_PHRASES) {
    if (lower.includes(phrase)) {
      return nack(`speculative language in commit message: '${phrase}'`);
    }
  }
  // A question mark right after a claim word expresses doubt about the claim.
  if (/\b(fix|fixes|fixed|works|worked)\s*\?/.test(lower)) {
    return nack("speculative '?' after a claim in commit message");
  }
  return ack();
}

/** `ketchup-plan-format`: structural checks on the committed plan file. */
function checkKetchupPlanFormat(
  context: CommitContext,
  helpers: Tier0Helpers,
): CheckerResult {
  if (!context.files.includes("ketchup-plan.md")) return ack();

  const content = helpers.readStagedFile("ketchup-plan.md");
  if (content === null) {
    // Can't read staged content — let it through rather than block blindly.
    return ack();
  }

  if (!/^##\s+TODO\b/m.test(content)) {
    return nack("ketchup-plan.md is missing a '## TODO' section");
  }
  if (!/^##\s+DONE\b/m.test(content)) {
    return nack("ketchup-plan.md is missing a '## DONE' section");
  }

  // Bottles must be named by capability, not sequence ("### Bottle 1").
  if (/^###\s+Bottle\s+\d+/m.test(content)) {
    return nack(
      "ketchup-plan.md names a bottle by number — use a capability name",
    );
  }

  // Placeholder signals.
  const placeholders = [
    /\bTBD\b/,
    /\bTODO:/,
    /\bFIXME\b/,
    /\bXXX\b/,
    /<placeholder>/i,
    /<fill in>/i,
    /\?\?\?/,
    /\[depends:\s*TBD\]/i,
  ];
  for (const re of placeholders) {
    if (re.test(content)) {
      return nack(
        `ketchup-plan.md contains placeholder content (${re.source})`,
      );
    }
  }

  // Every burst line should carry dependency notation.
  const burstLines = content
    .split("\n")
    .filter((l) => /^-\s+\[[ xX]\]\s+Burst\b/.test(l));
  for (const line of burstLines) {
    if (!/\[depends:/.test(line)) {
      return nack(
        "ketchup-plan.md has a burst missing '[depends: ...]' notation",
      );
    }
  }

  return ack();
}
