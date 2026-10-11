# Changelog

All notable changes to NutriPal MCP are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-11

First public release. A Bun + TypeScript MCP server that talks to MyFitnessPal's
website endpoints over stdio, using your own browser session.

### Added

**Session and setup**

- `bun run auth` — hidden-prompt CLI that verifies a MyFitnessPal session cookie
  against the account endpoint before saving it.
- Session stored at `~/.config/nutripal-mcp/session` with `0700` on the directory
  and `0600` on the file. Overridable with `MFP_DATA_DIR`.
- `MFP_COOKIE` environment variable accepts a bare token or a full `Cookie` header,
  taking precedence over the stored session.
- Session values are never printed by any command.

**Diary and notes**

- `get_diary` — read one day of food entries.
- `get_diary_range` — read up to 31 days, rejecting wider ranges with a clear error.
- `get_daily_note` — read the food diary note for a date.
- `get_food_settings` — read diary settings including configured meal labels.

**Food database and My Foods**

- `search_food` — search the public catalog with pagination, returning exact IDs
  and serving options.
- `get_food` — read nutrition and serving sizes for one food ID.
- `list_my_foods` — list private custom foods, including ones absent from public search.
- `create_food` — create a private custom food with calories, macros and optional
  nutrients (fiber, sugar, sodium, saturated fat, cholesterol, potassium).
- `update_my_food` — partial edit of a private food by exact ID; only supplied
  fields are changed.
- `delete_my_food` — delete a private food by exact ID.
- `country_code` on custom foods defaults to `US` (total carbs); pass a two-letter
  European code for net-carb label conventions.

**Logging**

- `log_food` — log an exact food ID and serving. Never guesses among matches.
- `create_and_log_food` — create a custom food and log it in one call. If the diary
  write fails, the created food ID and a recovery instruction are returned so the
  entry can be logged without creating a duplicate.
- `update_diary_entry` — change a serving count by exact entry ID.
- `delete_diary_entry` — delete a diary entry by exact ID.

**Meals, recent foods, water and measurements**

- `list_my_meals`, `delete_my_meal` — read and remove saved meals.
- `list_recent_foods` — recent or frequent foods computed from up to 31 diary days.
- `get_water`, `log_water` — read water, or set it in cups or millilitres.
- `get_measurements`, `log_weight` — read body measurements, log weight in kg or lbs.

**Validation and safety**

- Every tool input is validated with Zod, including ISO `YYYY-MM-DD` dates,
  finite non-negative nutrition values and bounded meal positions.
- Tools are annotated with `readOnlyHint` / `destructiveHint` so MCP clients can
  warn before destructive calls.
- Error messages are sanitized: response bodies, tokens and `Bearer` values are
  stripped before anything reaches the client.

**CLI scripts**

- `bun run live-check` — read-only sweep of session, My Foods, diary, food search
  and details, saved meals, food settings, notes, goals, recent foods, water and
  measurements.
- `bun run live-check --write` — creates one temporary private food, verifies and
  edits it, logs and edits one diary entry, then deletes both. On cleanup failure
  it prints the temporary name or ID for manual removal.
- `bun run log-by-weight <food> <grams>` — interactive weight-based logging with
  ranked exact-match selection, a gram serving default and `--date` / `--meal`
  overrides.
- `bun run diagnose` — probes read-only food routes and prints status codes and
  response structure without printing the session or response bodies.

**Project**

- 8 unit tests covering session normalization, food ID handling and request paths.
- `tsc --noEmit` typecheck, TypeScript 7, Bun runtime.
- MIT license.
