#!/usr/bin/env node
import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const USAGE = `NutriPal MCP v${version}

Usage:
  nutripal-mcp                         Start the MCP server on stdio
  nutripal-mcp auth [--profile NAME]   Verify and save a named session
  nutripal-mcp live-check [--profile NAME] [--write]
  nutripal-mcp log-by-weight <food> <grams> [--date YYYY-MM-DD] [--meal NAME]
  nutripal-mcp diagnose
  nutripal-mcp --version
  nutripal-mcp --help

Sessions: ~/.config/nutripal-mcp/sessions/<profile>. MFP_COOKIE is invocation-only.
Docs: https://github.com/naoufalelbani/nutripal-mcp`;

const [, , command, ...rest] = process.argv;
if (["--version", "-v"].includes(command)) { console.log(version); process.exit(0); }
if (["--help", "-h", "help"].includes(command)) { console.log(USAGE); process.exit(0); }
const script = command === undefined || command === "serve" || command === "server" ? "server"
  : ["auth", "live-check", "log-by-weight", "diagnose"].includes(command) ? command : null;
if (!script) { console.error(`Unknown command: ${command}\n${USAGE}`); process.exit(1); }
process.argv = [process.argv[0], process.argv[1], ...rest];
const built = new URL(`../dist/${script}.js`, import.meta.url);
try { await access(built); await import(built.href); }
catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const source = new URL(`../src/${script}.ts`, import.meta.url);
  if (typeof Bun !== "undefined") await import(source.href);
  else {
    const child = spawnSync("bun", [fileURLToPath(source), ...rest], { stdio: "inherit" });
    if (child.error) {
      console.error("Built JavaScript is missing. Run `bun run build` before using Node, or install Bun for source loading.");
      process.exit(1);
    }
    process.exit(child.status ?? 1);
  }
}
