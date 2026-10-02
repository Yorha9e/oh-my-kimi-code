---
"@moonshot-ai/kimi-code-sdk": patch
---

Wire the subagent model-binding session methods to agent-core-v2: `getSubagentBindings` / `setSubagentBinding`, `getSubagentSlotBindings` / `setSubagentSlotBinding`, the four global-layer counterparts, and `listSubagentProfiles` no longer throw `not_implemented` on the v2 client. The v1 file surface is preserved — workspace bindings live in `<projectRoot>/.kimi-code/local.toml` (`[subagent.<type>]` / `[subagent-slot.<name>]`), global ones in `<home>/local.toml`, and a bound model alias is validated against the model catalog before the write (unknown aliases reject with `config.invalid` on both engines).
