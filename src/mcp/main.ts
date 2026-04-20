import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.ts";

/**
 * Entry point for the `sandbox-seed-mcp` bin. Spawned by MCP hosts
 * (Claude Desktop, Cursor, custom agents) as a subprocess over stdio.
 *
 * IMPORTANT: do not write to stdout — stdio is the MCP transport.
 * Diagnostic output must go to stderr.
 */
export async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  async function shutdown(): Promise<void> {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  }
}
