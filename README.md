# pi-ketchup

**Turn every AI mistake into a rule AI can't repeat.**

[pi](https://pi.dev) extension port of [Ketchup](https://github.com/BeOnAuto/ketchup) — an LLM-powered guardrail engine that runs validators on every AI commit, injects reminders into context, and enforces deny-lists to protect files.

## What It Does

- **Commit validators** — Runs a separate `pi -p` sub-agent against every `git commit` with your rules as context. Blocks bad commits and tells you why.
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
---

You are validating a git commit. Check that [your criteria here].

Respond with JSON only:

- If the commit passes: {"decision":"ACK"}
- If the commit fails: {"decision":"NACK","reason":"explanation"}
```

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
