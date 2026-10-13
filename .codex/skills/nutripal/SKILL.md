---
name: nutripal
description: Use NutriPal MCP tools to read or update MyFitnessPal food, diary, nutrition, exercise, and account data.
---

# NutriPal MCP

Batch independent read-only NutriPal MCP calls in parallel within or across profiles. Writes for one profile run in order; writes for different profiles can run concurrently. Wait for a call's result before any call that needs it. Tool annotations identify which tools are read-only.

Use `profile` when working with a named account; otherwise the server uses `MFP_PROFILE` or `default`. Prefer `serving_size_id` when logging a catalog food. If a diary write returns `persisted: false`, use the returned ID and reason to reconcile the diary before retrying.
