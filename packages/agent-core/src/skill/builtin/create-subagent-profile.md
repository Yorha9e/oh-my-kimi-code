---
name: create-subagent-profile
description: Create a user-defined subagent profile — a Markdown file under the home agents dir that adds a new subagent type the Agent/AgentSwarm tools can dispatch. Use when the user wants a reusable subagent role (e.g. a debater, reviewer, or stack expert), wants the same role on multiple models, or asks to "save" a way of working as an agent.
---

# Create a custom subagent profile

omkc lets the user define their own subagent types as Markdown files. Once a
file exists, every new session sees it: the main agent's `Agent`/`AgentSwarm`
tools list it as a `subagent_type`, and it can be bound to a model like any
builtin type. Your job in this skill is to write that file well — the profile's
`description` / `whenToUse` are the ONLY signals the main agent has when
deciding to dispatch it, so they matter more than the prompt body.

Profiles are **home-only** — there is no project-level override. Resolve the
home directory first; never assume `~/.omkc`:

```bash
echo "$OMKC_HOME"
echo "$KIMI_CODE_HOME"
echo "$HOME/.omkc"
```

Use the first non-empty line; otherwise use the last one. The profiles live in
`<home>/agents/` below that root.

## File format

One file per profile: `<home>/agents/<name>.md`. Frontmatter fields are all
optional; the body is the role prompt.

```markdown
---
name: debater
description: Multi-perspective debater — attacks a plan from opposing views and returns a structured verdict
whenToUse: When a design, plan, or conclusion needs adversarial review from both sides before it is trusted
tools:
  - Bash
  - Read
  - Grep
---

You are a debater. Given a topic and an assigned stance (pro / con / devil's
advocate), attack the reasoning: find holes, unstated assumptions, and risks.
Close with a structured verdict. Argue with evidence, never restate the topic.
```

| Field | Default when omitted |
| --- | --- |
| `name` | File name without `.md`; lowercase letters/digits/hyphens only (`^[a-z0-9][a-z0-9-]*$`) |
| `description` | First line of the body |
| `whenToUse` | Empty; fill it — it is the dispatch guidance the main agent reads |
| `tools` | Inherits the full `coder` tool set; give a list to restrict (e.g. a read-only role drops edit tools) |
| `slot` | None; declares a named model slot (`[subagent-slot.<name>]`) the profile follows on spawn — OMKC extension, see below |
| `model_preference` | None; upstream field (`primary` / `secondary`) still supported — see below |

The body is appended after the builtin coder preamble ("you are a subagent,
the caller is the main agent…"), so **only write the role itself** — never
re-explain subagent mechanics, output format plumbing, or how results return.

## Rules that bite

- **Name collisions with builtin types** (`coder`, `explore`, `plan`, …) are
  skipped with a warning — pick a distinct name.
- A broken file (bad frontmatter, illegal name) is skipped with a warning and
  never blocks startup — but it also silently does nothing, so verify after
  writing.
- Profiles load once per process: **the file takes effect in NEW sessions**.
  Tell the user to `/new` or restart after creating one.
- Keep the description short — it is injected into the Agent tool description
  of every future main-agent context.

## After creating: bind a model (optional)

The profile inherits the caller's model by default. To pin one:

- `/subagent-model set <name>` interactively, or
- `[subagent.<name>]` in the workspace `.kimi-code/local.toml`, or
- the Subagent models panel under `/settings` (user profiles are listed and
  tagged).

To make a profile follow a named slot automatically (without passing
`binding_slot` on every dispatch), declare it in the frontmatter — this is the
recommended pattern for a fixed role↔slot pairing:

```markdown
---
name: debater
description: Multi-perspective debater
slot: debater
---
```

with a matching `[subagent-slot.debater]` entry in `.kimi-code/local.toml`
(workspace level; the global `~/.omkc/local.toml` is the fallback layer).
Spawn resolves top-down: explicit per-dispatch override → `[subagent.<name>]`
type binding → the profile's declared `slot` binding → inherit the main
agent. A level that is absent, set to `inherit = true`, or points at a model
alias that no longer exists is skipped silently (with a log warning).

For "same role, several models" (e.g. a panel of debaters on different
models), do NOT duplicate the profile with different names — create ONE
profile and give each instance a named slot (`[subagent-slot.<name>]` in
`.kimi-code/local.toml`), then dispatch with `subagent_type` + `binding_slot`
(or pin one slot permanently via the `slot` frontmatter above). Duplicate
profiles waste main-context tokens on repeated descriptions; slots exist
exactly to avoid that.

Upstream compatibility: the upstream kimi-code field
`model_preference: primary` / `model_preference: secondary` is still parsed
and behaves exactly as before (a `secondary` preference spawns the profile on
the configured secondary model). `slot` and `model_preference` coexist: the
stored slot binding applies when present, otherwise the preference/inherit
path runs. Converting between them is just frontmatter plus TOML — add
`slot: <name>` and a `[subagent-slot.<name>]` entry to move a profile onto a
slot; remove both to fall back to `model_preference` or parent inheritance.

## Verify

1. Re-read the file you wrote and check frontmatter parses (YAML, no tabs).
2. Tell the user: new sessions will list `<name>` as a subagent type;
   `/subagent-model list` shows it with a `(user)` tag once they restart.
