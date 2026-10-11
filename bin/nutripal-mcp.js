#!/usr/bin/env bun
// Launcher for the `nutripal-mcp` bin.
//
// With no arguments it starts the MCP server on stdio, which is what an MCP client expects.
// Named subcommands run the bundled CLI scripts.

if (typeof Bun === "undefined") {
  console.error(
    "NutriPal MCP requires the Bun runtime, but this command was started by another JavaScript runtime.\n\n" +
      "Fix it in one of these ways:\n" +
      "  - Install Bun (https://bun.sh) and run: bunx nutripal-mcp auth\n" +
      "  - Or clone the repo and run: bun run auth\n\n" +
      "Node.js cannot execute this package because it loads TypeScript sources directly.",
  );
  process.exit(1);
}

const { version } = await Bun.file(new URL("../package.json", import.meta.url)).json();

const USAGE = `NutriPal MCP v${version}

Usage:
  bunx nutripal-mcp                     Start the MCP server on stdio
  bunx nutripal-mcp auth                Save and verify a MyFitnessPal session cookie
  bunx nutripal-mcp live-check          Test every read endpoint against your account
  bunx nutripal-mcp live-check --write  Also test one temporary food and diary write
  bunx nutripal-mcp log-by-weight <food> <grams> [--date YYYY-MM-DD] [--meal NAME]
  bunx nutripal-mcp diagnose            Probe food routes and print status codes
  bunx nutripal-mcp --version           Print the installed version
  bunx nutripal-mcp --help              Show this message

Your MCP client should run \`bunx nutripal-mcp\` with no arguments.

Session: stored at ~/.config/nutripal-mcp/session, or supplied via MFP_COOKIE.
Docs: https://github.com/naoufalelbani/nutripal-mcp`;

const [, , command, ...rest] = process.argv;

// Some scripts read process.argv directly, so drop the subcommand before loading them.
const scriptArgs = () => { process.argv = [process.argv[0], process.argv[1], ...rest]; };

switch (command) {
  case undefined:
  case "serve":
  case "server":
    await import("../src/server.ts");
    break;
  case "auth":
    await import("../src/auth.ts");
    break;
  case "live-check":
    scriptArgs();
    await import("../src/live-check.ts");
    break;
  case "diagnose":
    await import("../src/diagnose.ts");
    break;
  case "log-by-weight":
    scriptArgs();
    await import("../src/log-by-weight.ts");
    break;
  case "--version":
  case "-v":
    console.log(version);
    break;
  case "--help":
  case "-h":
  case "help":
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    process.exit(1);
}
