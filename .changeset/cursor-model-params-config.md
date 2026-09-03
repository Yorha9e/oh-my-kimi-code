---
"oh-my-kimi-code": patch
---

Allow configuring Cursor model parameters such as `fast` and `context` per model via `model_params` in `config.toml` (for example `model_params = { fast = "true" }` on the `[models."<id>"]` entry).