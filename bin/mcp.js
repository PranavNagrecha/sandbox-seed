#!/usr/bin/env node
// sandbox-seed-mcp entry. Loads the compiled MCP server and wires stdio.
// For source-mode dev runs, use `node --experimental-strip-types bin/mcp-dev.ts`.
import { main } from "../dist/mcp/main.js";

main().catch((err) => {
  process.stderr.write(`[sandbox-seed-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
