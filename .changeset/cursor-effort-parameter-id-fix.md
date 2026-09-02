---
"@moonshot-ai/kosong": patch
---

Fix the cursor wire dropping the thinking effort for models whose catalog declares the parameter as `effort` rather than `reasoning`, send `thinking=true` for models that advertise the boolean thinking parameter, and fall back to the bare model id when the requested effort is outside the model's declared values.