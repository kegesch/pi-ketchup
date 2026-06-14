# pi-ketchup

**Turn every AI mistake into a rule AI can't repeat.**

[pi](https://pi.dev) extension port of [Ketchup](https://github.com/BeOnAuto/ketchup) — an LLM-powered guardrail engine that runs validators on every AI commit, injects reminders into context, and enforces deny-lists to protect files.

## What It Does

- **Commit validators** — Runs against every `git commit` with your rules as context. Blocks bad commits and tells you why. Each validator runs on a [tier](#validation-tiers--models): deterministic code (tier 0), a small/local model (tier 1), or a capable model (tier 2) — so trivial checks cost nothing and only the hard ones pay for a large model.
- **Reminders** — Markdown files with YAML frontmatter that inject context at the right moment (session start, every prompt, before tool use).
- **Deny-list** — Glob patterns that protect files from modification.
- **Config commands** — `/ketchup:init`, `/ketchup:config show`, etc.

## Installation

### As a pi package (recommended)

```bash
pi install git:github.com/user/pi-ketchup
```

### Manual

Copy this directory to `~/.pi/agent/extensions/ketchup/` and install dependencies:

```bash
cd ~/.pi/agent/extensions/ketchup
npm install
```

### Load directly

```bash
pi -e /path/to/pi-ketchup/extensions
```

## Quick Start

```
/ketchup:init
```

This creates `.ketchup/` with default configuration. Then just work normally — Ketchup watches in the background.

## Commands

| Command                                                        | Description                         |
| -------------------------------------------------------------- | ----------------------------------- |
| `/ketchup:init`                                                | Initialize Ketchup for this project |
| `/ketchup:config show`                                         | Show current configuration          |
| `/ketchup:config validators`                                   | List validators with status         |
| `/ketchup:config validators enable <name>`                     | Enable a validator                  |
| `/ketchup:config validators disable <name>`                    | Disable a validator                 |
| `/ketchup:config reminders`                                    | List reminders with status          |
| `/ketchup:config reminders enable/disable <name>`              | Toggle a reminder                   |
| `/ketchup:config reminders priority <name> <n>`                | Set reminder priority               |
| `/ketchup:config reminders add <name> [hook] --content <text>` | Add a reminder                      |
| `/ketchup:config set <key.path> <value>`                       | Set a config value                  |
| `/ketchup:models`                                             | Configure which model each tier uses |

## How It Maps from Claude Code to Pi

| Ketchup (Claude Code)                    | pi-ketchup                               |
| ---------------------------------------- | ---------------------------------------- |
| `hooks.json: SessionStart`               | `pi.on("session_start")`                 |
| `hooks.json: PreToolUse`                 | `pi.on("tool_call")`                     |
| `hooks.json: UserPromptSubmit`           | `pi.on("before_agent_start")`            |
| Returns `{ permissionDecision: "deny" }` | Returns `{ block: true, reason }`        |
| Returns `{ additionalContext }`          | Injects via `before_agent_start` message |
| Spawns `claude -p` for validation        | Spawns `pi -p` for validation            |
| `CLAUDE_PLUGIN_ROOT` env var             | Resolved from extension directory        |

## Custom Validators

Create `.ketchup/validators/my-rule.md`:

```markdown
---
name: my-rule
description: Enforce my custom rule
enabled: true
tier: 2
---

You are validating a git commit. Check that [your criteria here].

Respond with JSON only:

- If the commit passes: {"decision":"ACK"}
- If the commit fails: {"decision":"NACK","reason":"explanation"}
```

`tier` controls how the rule runs (see [Validation Tiers & Models](#validation-tiers--models)). Omit it and the rule defaults to **tier 2** (capable model).

## Validation Tiers & Models

Not every guardrail needs a frontier model. Each validator declares a
`tier` that controls *how* it runs, so the trivial pattern checks cost
nothing and the genuinely semantic ones get the model they need:

| Tier | How it runs                                         | When to use it                                  |
| ---- | --------------------------------------------------- | ----------------------------------------------- |
| `0`  | **Deterministic code** — no model, no tokens        | Substring / regex / filename / message checks   |
| `1`  | Small / local model                                 | Read a diff, apply a clear rule list, emit JSON |
| `2`  | Capable model (default)                             | Cross-file reasoning, intent, subjective calls |

With the default config (no tier models set), tiers 1 and 2 both fall back
to pi's default model — so nothing changes until you opt in. Pointing tier 1
at a small/local model is the big win: the bulk of validators run cheap and
fast while only the hard ones pay for a large model.

### Configuring models

```
/ketchup:models
```

Opens an interactive picker (when the TUI is available): first choose a tier,
then pick a model from your configured catalog. Selections are persisted to
`.ketchup/state.json`:

```json
{
  "models": {
    "tier1": { "provider": "ollama", "id": "qwen2.5-coder:7b" },
    "tier2": { "provider": "anthropic", "id": "claude-opus-4-1" }
  }
}
```

In a non-interactive context (print mode, scripts, sub-agents), set or clear
models directly:

```
/ketchup:models tier1 ollama/qwen2.5-coder:7b
/ketchup:models tier2 clear
/ketchup:models show
```

Tier 0 always runs as code, so it never appears in the model picker.

## Custom Reminders

Create `.ketchup/reminders/my-reminder.md`:

```markdown
---
when:
  hook: UserPromptSubmit
priority: 50
---

Your reminder content here. This gets injected on every prompt.
```

### Triggering by file extension (alternative to `hook`)

Instead of firing on a lifecycle hook, a reminder can fire only when the
agent **reads** a file whose extension matches. Declare `when.extensions`
instead of (or alongside) `when.hook`:

```markdown
---
when:
  extensions:
    - .ts
    - .tsx
priority: 80
---

You just opened a TypeScript file. Keep it strict: no `any`, no `@ts-ignore`.
```

How it works:

- When `extensions` is set, the reminder is **excluded** from the
  `SessionStart` / `UserPromptSubmit` / `PreToolUse` hook flows.
- The moment the `read` tool opens a file with a matching extension, the
  reminder is injected as a steering message, so it lands in context right
  after the read — before the agent's next action on that file.
- Extensions are normalized (case-insensitive, leading dot added if missing,
  so `ts`, `TS`, and `.ts` all match).
- Each extension-based reminder is injected at most once per session to avoid
  context bloat (the tracker resets on `session_start`).

See `reminders/reminder-typescript-strict-on-read.md` for a working example.

## Configuration

`.ketchup/state.json`:

```json
{
  "validateCommit": { "mode": "strict", "batchCount": 3 },
  "denyList": { "enabled": true },
  "promptReminder": { "enabled": true },
  "subagentHooks": {
    "validateCommitOnExplore": false,
    "validateCommitOnWork": true,
    "validateCommitOnUnknown": true
  },
  "models": {
    "tier1": { "provider": "ollama", "id": "qwen2.5-coder:7b" },
    "tier2": { "provider": "anthropic", "id": "claude-opus-4-1" }
  }
}
```

Commit validation modes:

- `"strict"` — Block commits that fail validation
- `"warn"` — Log warnings but allow commits through
- `"off"` — Skip validation entirely

## Credits

Based on [Ketchup](https://github.com/BeOnAuto/ketchup) by [BeOnAuto](https://on.auto). Original license: MIT.

## License

MIT
