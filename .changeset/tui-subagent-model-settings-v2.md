---
"oh-my-kimi-code": patch
---

Fix the subagent model settings page failing to load under the v2 engine with `Failed to load subagent model bindings: [not_implemented]` — the v2 SDK client now implements the binding accessors the page calls.
