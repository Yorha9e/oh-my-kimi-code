---
"oh-my-kimi-code": minor
---

Add per-workspace model and thinking-effort bindings for subagent types, enabled by default in this fork. Bind configured model aliases to subagent types in `.kimi-code/local.toml`; bindings are applied mechanically to `Agent` and `AgentSwarm` spawns (the calling agent cannot override them), are managed via the `/subagent-model` command, and resumed subagents always keep the model they were configured with instead of realigning to the parent.
