---
"oh-my-kimi-code": patch
---

Restore the v1 per-type binding layer on the v2 spawn chain: `[subagent.<type>]` entries in `.kimi-code/local.toml` (workspace) and `<home>/local.toml` (global) are now resolved when spawning subagents, sitting below the named slot exactly like v1's `workspace slot > workspace type` order (full chain: explicit choice > `[agent_types]` > slot > local type > secondary > caller). Bindings written by the settings page and `/subagent-model` therefore actually take effect under v2. Also registers the `subagent-model-selection` flag in the v2 engine (on by default), restoring the `/subagent-model` command's availability.
