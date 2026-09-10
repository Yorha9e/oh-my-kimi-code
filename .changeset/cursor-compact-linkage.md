---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core-v2": patch
---

Link local context compaction to cursor native sessions: compacting a cursor-backed agent now collapses its saved protocol snapshot to the official summary-blob shape under the same conversation id, so follow-up requests stay within the reduced context.
