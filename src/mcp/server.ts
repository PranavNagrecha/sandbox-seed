import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SeedError } from "../errors.ts";
import { seed, SeedArgs } from "./tools/seed.ts";

/**
 * The MCP server exposes ONE tool: `seed`.
 *
 * `seed` is the entire product surface. It is an agentic, multi-turn workflow:
 * the AI calls it with `action: "start"`, threads the returned `sessionId`
 * through `analyze` → `select` → `dry_run` → `run`. Each step returns
 * metadata-only output (the AI-boundary contract) and guidance for the next step.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: "sandbox-seed",
      version: "0.1.1",
    },
    {
      instructions:
        "sandbox-seed copies Salesforce records between orgs with AI-safe boundaries. " +
        "Core rules, regardless of which tool you call:\n\n" +
        "1. Record data never leaves disk. Do not ask the tool to 'return the rows' " +
        "or 'show me the data' — it can't, by design. You see counts, schemas, paths, " +
        "and plan hashes only.\n" +
        "2. WHERE clauses are SOQL typed by the user. Do not invent predicates from " +
        "natural language ('biggest', 'recent'). If the user's intent is fuzzy, ask " +
        "them for a SOQL WHERE clause before calling any tool.\n" +
        "3. Targets must be sandboxes. Production writes are refused at the tool layer — " +
        "do not try to 'just this once' bypass this.\n" +
        "4. dry_run is mandatory before run. If the user says 'just do it', walk them " +
        "through dry_run first, show the report path, then confirm.",
    },
  );

  server.registerTool(
    "seed",
    {
      title: "Copy records across Salesforce orgs (source → sandbox) with FK remapping",
      description:
        "Copy real Salesforce records from one org into a sandbox — with dependency-graph " +
        "walking, cross-org FK remapping, cycle handling, and a mandatory dry-run gate. " +
        "All record data stays on disk; the AI sees only counts, paths, and plan metadata.\n\n" +
        "WHEN TO USE THIS TOOL\n" +
        "  Any user request that means 'get real data from org A into sandbox B':\n" +
        "    • 'seed my sandbox with last-quarter Opportunities'\n" +
        "    • 'copy these Accounts from prod to the dev sandbox'\n" +
        "    • 'move 50 Cases and their Contacts into UAT'\n" +
        "    • 'populate my scratch org with Orders'\n" +
        "    • 'migrate Opportunities where Amount > 100000 into the full sandbox'\n" +
        "  Also: any follow-up turn in an in-progress seeding session (thread sessionId).\n\n" +
        "WHEN NOT TO USE THIS TOOL\n" +
        "  • One-off ad-hoc query → use `sf data query` or @salesforce/mcp.\n" +
        "  • Metadata deploy (objects, fields, flows) → use `sf project deploy`.\n" +
        "  • Static reference data (`sf data import tree` + a checked-in JSON) → simpler.\n" +
        "  • DO NOT hand-roll this with a SOQL query + bulk insert from another MCP. " +
        "It WILL break: cross-org IDs don't match, cycles (Account↔Contact) fail, " +
        "master-detail parents must pre-exist, and record data leaks into the prompt.\n\n" +
        "HOW TO CALL IT\n" +
        "  Five-step wizard. Thread sessionId through every call.\n" +
        "    1. action:\"start\"    { sourceOrg, targetOrg, object, whereClause }\n" +
        "    2. action:\"analyze\"  { sessionId }                — returns parents/children\n" +
        "    3. action:\"select\"   { sessionId, include: [...] } — user picks optionals\n" +
        "    4. action:\"dry_run\"  { sessionId }                — MANDATORY, writes plan\n" +
        "    5. action:\"run\"      { sessionId, confirm:true }  — only after user says go\n\n" +
        "  Hard rules (tool will reject violations):\n" +
        "    • whereClause MUST be SOQL typed by the user ('Amount > 100000', " +
        "'CloseDate = THIS_QUARTER'). DO NOT invent one. If the user says 'the largest', " +
        "'recent ones', 'top 3' — STOP and ask for a SOQL predicate.\n" +
        "    • Target MUST be a sandbox (Organization.IsSandbox=true). Production targets " +
        "are refused.\n" +
        "    • After dry_run, show the user the report path and wait for explicit " +
        "confirmation before action:\"run\".\n\n" +
        "  Example first call:\n" +
        "    { action: \"start\",\n" +
        "      sourceOrg: \"prod\",\n" +
        "      targetOrg: \"dev-full\",\n" +
        "      object: \"Opportunity\",\n" +
        "      whereClause: \"CloseDate = THIS_QUARTER AND Amount > 50000\" }",
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
