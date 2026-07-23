---
"oh-my-kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add a global layer to subagent model bindings: bindings can now also live in `~/.omkc/local.toml` using the same `[subagent.<type>]` / `[subagent-slot.<name>]` format, resolved after the workspace layer (workspace slot > global slot > workspace type > global type > inherit). The SDK gains matching `getGlobalSubagentBindings` / `setGlobalSubagentBinding` / `getGlobalSubagentSlotBindings` / `setGlobalSubagentSlotBinding` session methods.
