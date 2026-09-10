---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core-v2": patch
---

Switching back to a Cursor model now folds intermediate turns made on other models into the Cursor context, so cross-model conversations keep their full history.
