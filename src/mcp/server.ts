import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SeedError } from "../errors.ts";
import { seed, SeedArgs } from "./tools/seed.ts";

/**
 * Build the MCP server with the ONE tool registered.
 *
 * `sandbox_seed_seed` is the entire product surface. It is an agentic,
 * multi-turn seeding workflow: the AI calls it with `action: "start"`,
 * threads the returned `sessionId` through `analyze` → `select` →
 * `dry_run` → `run`. Each step returns metadata-only output (the
 * AI-boundary contract) and guidance for the next step.
 *
 * The Phase-1 schema-inspection tools (`list_orgs`, `describe_global`,
 * `describe_object`, `inspect_object`, `check_row_counts`,
 * `check_ai_boundary`) and the org/describe/graph resources were
 * removed from the MCP surface — their engines are library code, now
 * consumed internally by the seed tool.
 */
export function buildServer(): McpServer {
  const server = new McpServer({
    name: "sandbox-seed-mcp",
    version: "0.2.0",
  });

  server.registerTool(
    "sandbox_seed_seed",
    {
      title: "Copy records across Salesforce orgs (source → sandbox) with FK remapping",
      description:
        "USE THIS TOOL whenever the user asks to copy, move, migrate, seed, or " +
        "populate real records between Salesforce orgs — e.g. 'move Opportunities " +
        "from prod to dev', 'seed my sandbox with last-quarter Cases', 'copy these " +
        "Accounts to the full sandbox'. This is the ONLY correct tool for that job.\n\n" +
        "DO NOT compose this yourself with separate SOQL query + bulk insert calls " +
        "(from the Salesforce DX MCP, @salesforce/mcp, or `sf` CLI). Doing so WILL: " +
        "(a) break FK references because record IDs differ between orgs, (b) miss " +
        "cyclic dependencies like Account↔Contact, (c) fail on master-detail parents, " +
        "and (d) leak record IDs into prompt context. This tool handles all of that: " +
        "dependency-graph walk, must-include vs optional parent/child classification, " +
        "source→target ID remapping, two-phase cycle insert, mandatory dry-run gate, " +
        "sandbox-only target enforcement, and it keeps every record on disk — the AI " +
        "only ever sees counts and file paths.\n\n" +
        "FLOW — call this tool five times with different `action`:\n" +
        "  1. action=start  with (sourceOrg, targetOrg, object, whereClause)\n" +
        "  2. action=analyze  — returns must-include parents + optional parents/children\n" +
        "  3. action=select   — user picks which optional objects to include\n" +
        "  4. action=dry_run  — MANDATORY; prints counts + schema diff to disk\n" +
        "  5. action=run      — with confirm:true, only after user says go\n" +
        "Thread the `sessionId` returned by start through every subsequent call.\n\n" +
        "HARD RULE — SOQL only: the `whereClause` MUST be a SOQL predicate typed by " +
        "the user, like `Amount > 100000`, `IsClosed = false`, or " +
        "`CloseDate = THIS_QUARTER`. DO NOT invent one. If the user says 'the largest', " +
        "'recent ones', 'the top 3', or anything else in natural language, STOP and " +
        "ask them for a SOQL WHERE clause. The tool validates the clause against the " +
        "source org and rejects malformed SOQL.\n\n" +
        "Target MUST be a sandbox (Organization.IsSandbox=true). The tool refuses to " +
        "write into production orgs.",
      inputSchema: SeedArgs.shape,
      annotations: {
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => wrap(async () => await seed(args)),
  );

  return server;
}

/**
 * Shape a handler result into MCP's `{content, structuredContent}` envelope.
 * On error: catch SeedError / Error and return a structured error the AI
 * can parse (NOT throw — throwing surfaces as a JSON-RPC error which the
 * host may treat as a server fault rather than a per-call failure).
 */
async function wrap<T>(fn: () => Promise<T>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  try {
    const result = await fn();
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return {
      content: [{ type: "text", text }],
      structuredContent:
        result !== null && typeof result === "object"
          ? (result as Record<string, unknown>)
          : undefined,
    };
  } catch (err) {
    const payload = shapeError(err);
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload as unknown as Record<string, unknown>,
      isError: true,
    };
  }
}

type ShapedError = {
  error: string;
  message: string;
  hint?: string;
  exitCode?: number;
};

function shapeError(err: unknown): ShapedError {
  if (err instanceof SeedError) {
    return {
      error: err.name === "AuthError" ? "auth_missing" : err.name,
      message: err.message,
      hint: err.hint,
      exitCode: err.exitCode,
    };
  }
  if (err instanceof Error) {
    return { error: err.name || "Error", message: err.message };
  }
  return { error: "UnknownError", message: String(err) };
}
