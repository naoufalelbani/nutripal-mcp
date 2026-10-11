#!/usr/bin/env bun
// Launcher for `bunx nutripal-mcp`. NutriPal is written in TypeScript and needs the Bun runtime.
if (typeof Bun === "undefined") {
  console.error(
    "NutriPal MCP requires the Bun runtime, but this command was started by another JavaScript runtime.\n\n" +
      "Fix it in one of these ways:\n" +
      "  - Install Bun (https://bun.sh) and run: bunx nutripal-mcp\n" +
      "  - Or clone the repo and run: bun run src/server.ts\n\n" +
      "Node.js cannot execute this package because it loads TypeScript sources directly.",
  );
  process.exit(1);
}

await import("../src/server.ts");
