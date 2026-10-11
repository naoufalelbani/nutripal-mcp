<p align="center">
  <img src="assets/banner.svg" alt="NutriPal MCP" width="100%" />
</p>

<p align="center">
  <strong>Your MyFitnessPal diary, food log, water and weight — controllable from any MCP client.</strong>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-555?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=%23000000" alt="Bun" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-stdio-2563eb" alt="MCP stdio" /></a>
  <a href="https://www.npmjs.com/package/nutripal-mcp"><img src="https://img.shields.io/npm/v/nutripal-mcp?label=npm" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" /></a>
  <a href="https://github.com/naoufalelbani/nutripal-mcp/releases"><img src="https://img.shields.io/github/v/release/naoufalelbani/nutripal-mcp?label=release" alt="Release" /></a>
  <a href="https://github.com/naoufalelbani/nutripal-mcp/actions"><img src="https://img.shields.io/badge/tests-8%20passing-brightgreen" alt="Tests" /></a>
</p>

---

NutriPal MCP is a local [Model Context Protocol](https://modelcontextprotocol.io/) server that gives an AI assistant
hands on your MyFitnessPal account. Ask *"what did I eat yesterday"*, *"log 116 g of banana as a snack"* or
*"I've had 500 ml of water today"* — and it happens in your real diary.

It runs as a single Bun process over **stdio**. There is no server to host, no port to open, no API key to buy,
and nothing leaves your machine except the requests NutriPal makes to MyFitnessPal on your behalf.

<p align="center">
  <img src="assets/capabilities.svg" alt="What you can do from chat" width="100%" />
</p>

## Table of contents

- [Why NutriPal](#why-nutripal)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Tools](#tools)
- [CLI scripts](#cli-scripts)
- [Food tab coverage](#food-tab-coverage)
- [Custom foods](#custom-foods)
- [Security](#security)
- [Limits](#limits)
- [Development](#development)
- [License](#license)

## Why NutriPal

| | |
| :--- | :--- |
| **No API key needed** | The [official developer API is private](https://www.myfitnesspal.com/apps/api/version). NutriPal uses the same website endpoints your browser uses, with your own session. |
| **Local and private** | stdio transport, no network listener, no telemetry. Your session cookie stays in `~/.config/nutripal-mcp/` with owner-only permissions. |
| **Exact IDs, never guesses** | `log_food` requires a food ID from search or your own list. If two foods look alike, you pick — the tool won't silently log the wrong one. |
| **Honest about failure** | `create_and_log_food` returns the new food ID even when the diary write fails, so you can retry without creating duplicates. |
| **Typed and tested** | Every tool input is Zod-validated, destructive tools are annotated for client-side warnings, and error output is sanitized before it reaches the model. |
| **Debuggable by design** | `live-check`, `live-check --write` and `diagnose` tell you exactly which endpoint broke when MyFitnessPal changes something. |

## How it works

<p align="center">
  <img src="assets/architecture.svg" alt="Request flow from MCP client through NutriPal to MyFitnessPal" width="100%" />
</p>

1. Your MCP client spawns `bun run src/server.ts` and talks to it over stdio.
2. NutriPal validates each tool call with Zod, then issues an HTTPS request to
   `www.myfitnesspal.com` using the `__Secure-next-auth.session-token` cookie.
3. The JSON response is returned to the client as a tool result. Writes require
   exact IDs and destructive tools are flagged with `destructiveHint`.

## Quick start

### 1. Install

You need [Bun](https://bun.sh/) v1.1 or newer — NutriPal is written in TypeScript and Bun runs it directly.

**One-off, from npm** — no clone needed:

```bash
bunx nutripal-mcp
```

**Or clone the repo:**

```bash
git clone https://github.com/naoufalelbani/nutripal-mcp.git
cd nutripal-mcp
bun install
```

> Running the package under Node.js fails on purpose: it loads TypeScript sources and prints a message
> telling you to switch to Bun.

### 2. Save your session

Sign in to [MyFitnessPal](https://www.myfitnesspal.com/) in your browser, open developer tools,
copy the value of the `__Secure-next-auth.session-token` cookie for `www.myfitnesspal.com`, then:

```bash
bun run auth
```

Paste the token at the hidden prompt. NutriPal verifies it against your account and stores it at
`~/.config/nutripal-mcp/session` (mode `0600`). The value is never echoed back.

> **Prefer not to store it?** Set `MFP_COOKIE` in the MCP client's environment instead. It accepts a
> bare token or a full `Cookie` header, and takes precedence over the stored session.

### 3. Register the server

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nutripal": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/nutripal-mcp/src/server.ts"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add nutripal -- bunx nutripal-mcp
```

**Cursor / Windsurf / VS Code** — same shape, in each editor's MCP settings file:

```json
{
  "mcpServers": {
    "nutripal": {
      "command": "bunx",
      "args": ["nutripal-mcp"]
    }
  }
}
```

Prefer the cloned repo instead? Swap the command for `"bun"` with `["run", "/absolute/path/to/nutripal-mcp/src/server.ts"]`.

### 4. Verify

```bash
bun run live-check
```

It checks your session plus every read path and prints a pass/fail list. Keep stdout clear when the
server runs — MCP messages own it, so errors go to stderr.

### 5. Try it in chat

> What did I eat yesterday?
>
> Log 116 grams of banana to today's snacks.
>
> I had a bowl of homemade lentil soup for lunch — save it as a custom food and log it.
>
> Set my water to 1500 ml and log today's weight as 74.2 kg.

## Tools

| Tool | Access | Action |
| --- | :---: | --- |
| `check_session` | read | Check whether the saved MyFitnessPal session works |
| `get_diary` | read | Read food diary entries for a date |
| `get_diary_range` | read | Read diary data across a date range of up to 31 days |
| `get_daily_note` | read | Read the food diary note for a date |
| `get_nutrition_goals` | read | Read current account nutrition goals |
| `search_food` | read | Search the food catalog and return exact IDs and serving options |
| `get_food` | read | Read nutrition and serving sizes for a food ID |
| `list_my_foods` | read | Find foods you created, including private foods |
| `list_my_meals` | read | List meals saved in My Meals |
| `list_recent_foods` | read | Recent or frequent foods from up to 31 diary days |
| `get_food_settings` | read | Read food diary settings, including meal labels |
| `get_water` | read | Read water logged on a date |
| `get_measurements` | read | Read body measurements such as weight |
| `create_food` | write | Save a private custom food with calories, macros and optional nutrients |
| `update_my_food` | write | Edit a private food by exact ID — only supplied fields change |
| `delete_my_food` | write | Delete a private food by exact ID |
| `log_food` | write | Log an exact food ID and serving |
| `create_and_log_food` | write | Save a custom food and log it on a day |
| `update_diary_entry` | write | Change the serving count of a diary entry by ID |
| `delete_diary_entry` | write | Delete a diary entry by ID |
| `delete_my_meal` | write | Delete a saved meal by exact ID |
| `log_water` | write | Set water intake for a date, in cups or milliliters |
| `log_weight` | write | Create or update a weight measurement for a date |

Meals are addressed by position: `0` breakfast, `1` lunch, `2` dinner, `3` snacks, and `4`/`5` for extra
meals if you enabled them. Use `get_food_settings` to read your own labels. Dates are always `YYYY-MM-DD`.

## CLI scripts

Everything the server can do is also reachable from the terminal.

| Command | What it does |
| --- | --- |
| `bun run auth` | Verify a session cookie and save it with owner-only permissions |
| `bun run start` | Launch the stdio server directly |
| `bun run live-check` | Read-only sweep of every endpoint the tools depend on |
| `bun run live-check --write` | Create one temporary private food, verify, edit, log, edit the entry, then delete both. Prints the temporary name or ID if cleanup fails so you can remove it manually |
| `bun run log-by-weight banana 116` | Log a food by gram weight. Shows ranked results, picks an exact match interactively, and defaults to today's Snacks |
| `bun run log-by-weight banana 116 --date 2026-10-11 --meal lunch` | Same, with explicit date and meal |
| `bun run diagnose` | Probe read-only food routes and print status codes plus response structure |
| `bun test` | Run the unit tests |
| `bun run typecheck` | `tsc --noEmit` |

`diagnose` and `live-check` never print the saved session or response bodies — only status codes and
the shape of what came back.

## Food tab coverage

These are implemented tool paths. Live account behavior still needs `bun run live-check`, because
MyFitnessPal's website endpoints can change without notice.

| MyFitnessPal page | Current MCP support |
| --- | --- |
| Food Diary | Read days, log foods, change serving counts, delete entries, read notes, read or set water |
| Database | Search foods and view nutrition and serving sizes |
| My Foods | Search/list, view, create, edit, and delete private foods |
| My Meals | List and delete saved meals |
| Recipes | No recipe tools yet |
| Settings | Read diary settings and nutrition goals |

My Meals creation and logging, recipe management and changing food settings still require the
MyFitnessPal website or app.

## Custom foods

For a custom food, nutrient amounts are **per serving**. The default serving is `1 serving`.
For a 100 g nutrition label, set `serving_amount: 100` and `serving_unit: "g"`.

`country_code` defaults to `US`, where carbohydrates means total carbs. Some European labels use net
carbs — pass the relevant two-letter country code when that applies.

<details>
<summary><code>create_food</code> example</summary>

```json
{
  "name": "Homemade lentil soup",
  "brand": "Home",
  "serving_amount": 1,
  "serving_unit": "bowl",
  "calories": 220,
  "protein": 14,
  "carbohydrates": 32,
  "fat": 5,
  "fiber": 9
}
```

Optional nutrients: `sugar`, `sodium`, `saturated_fat`, `cholesterol`, `potassium`.

</details>

<details>
<summary><code>create_and_log_food</code> — what happens if logging fails</summary>

The food is created first, and its ID is returned even when the diary write fails:

```json
{
  "created": { "id": "123456789", "...": "..." },
  "diary_error": "Diary write failed",
  "recovery": "The food was created as ID 123456789. Use log_food with that ID; do not create it again."
}
```

The model is then told to retry with `log_food`, so you never end up with two copies of the same food.

</details>

## Security

- The session cookie **grants full access to your MyFitnessPal account**. Treat it like a password.
- It is stored at `~/.config/nutripal-mcp/session` with `0600` permissions inside a `0700` directory.
  Override the location with `MFP_DATA_DIR`.
- No command prints the session value, and error output is filtered for tokens, `Bearer` values and
  `__Secure-next-auth` strings before it reaches the client.
- Do not commit the session file or paste its contents in an issue.
- NutriPal performs no analytics, makes no requests other than to MyFitnessPal, and opens no ports.

## Limits

- MyFitnessPal's website API is **undocumented and can change** at any time. When it does, run
  `bun run diagnose` to see which route moved.
- This project is **unaffiliated with MyFitnessPal**. It is not endorsed by or connected to
  MyFitnessPal, Inc.
- Some accounts receive Cloudflare challenges from non-browser clients. If that happens, refresh the
  browser session or use a network where MyFitnessPal allows the request.
- There is no password login and no automatic session renewal — when the session expires, save a new one.
- No local diary cache: reads reflect MyFitnessPal's current response.
- Recipe tools and My Meals creation are not implemented.

## Development

```bash
bun install        # install dependencies
bun test           # 8 unit tests
bun run typecheck  # tsc --noEmit
bun run start      # run the stdio server
```

Project layout:

```
src/
  server.ts        # MCP tool registration and stdio transport
  mfp.ts           # MyFitnessPal HTTP client, session storage, error sanitizing
  auth.ts          # interactive session saver
  live-check.ts    # read-only and --write endpoint verification
  log-by-weight.ts # weight-based logging CLI
  diagnose.ts      # read-only route probe
test/
  mfp.test.ts
assets/            # banner and diagrams
```

Contributions are welcome. Please run `bun test` and `bun run typecheck` before opening a PR, and
include a `live-check` result if your change touches an endpoint.

## Releasing

CI runs the tests, typecheck and a package dry-run on every push and pull request.

Publishing to npm is automated. **Create a GitHub Release** and the
[`Publish to npm`](.github/workflows/publish.yml) workflow publishes the version in `package.json`:

```bash
# 1. bump "version" in package.json, update CHANGELOG.md, commit
git commit -am "Release v0.2.0"
git push

# 2. tag and publish the release
gh release create v0.2.0 --title "NutriPal MCP v0.2.0" --notes-file CHANGELOG.md
```

The workflow runs `bun test` and `bun run typecheck` before publishing, skips versions already on
npm so a re-run is safe, and attaches a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
linking the package back to this commit.

**One-time setup:** add an npm automation token as the `NPM_TOKEN` repository secret
(Settings -> Secrets and variables -> Actions). Create it at npmjs.com -> Access Tokens ->
Generate New Token -> **Automation**, so CI can publish without a one-time password.

## License

[MIT](LICENSE) © Naoufal Elbani
