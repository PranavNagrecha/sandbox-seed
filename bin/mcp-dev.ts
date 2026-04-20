#!/usr/bin/env node --experimental-strip-types
import { main } from "../src/mcp/main.ts";

main().catch((err) => {
  process.stderr.write(`[sandbox-seed-mcp dev] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
