---
"oh-my-kimi-code": patch
---

Scope image compression limits to each running engine instead of the process, so several engines in one process no longer overwrite each other's `[image]` limits and a config change applies to the next request without a restart.
