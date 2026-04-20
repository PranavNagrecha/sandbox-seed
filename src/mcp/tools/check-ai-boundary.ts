/**
 * Static, auditable statement of what this MCP server will and will not
 * return to an LLM. The AI is expected to cite this payload when asked
 * "what can this tool see?" or "can you run SOQL for me?".
 *
 * Never mutate this without updating phases/01-inspect.md in the same PR —
 * this payload is the project's canonical positioning statement.
 */
export type AiBoundaryPayload = {
  willReturn: string[];
  willNeverReturn: string[];
  enforcement: string;
  whyNoExecuteSoql: string;
  contrastWithGeneralPurposeMcps: string[];
};

export const AI_BOUNDARY: AiBoundaryPayload = {
  willReturn: [
    "sObject names, labels, custom flag, createable/queryable flags",
    "Field names, types, nillable, custom, createable, picklist values",
    "Reference metadata: referenceTo, relationshipName, cascadeDelete",
    "childRelationships entries (filtered: no *History/*Feed/*Share)",
    "recordTypeInfos: developerName, name, master flag",
    "Row counts via SELECT COUNT() (opt-in, aggregate scalar)",
    "IDs of records this server itself creates during seed (Phase 3)",
  ],
  willNeverReturn: [
    "Field values from existing records",
    "Record IDs of pre-existing records",
    "Results of any SELECT statement other than SELECT COUNT()",
    "Apex debug logs, execution logs, or anonymous Apex output",
    "Bulk API job results containing row data",
    "Anything from a generic REST passthrough — we do not expose one",
  ],
  enforcement:
    "Server source is grep-auditable: only SELECT COUNT() exists, only when includeCounts:true. A unit test fails CI if any tool handler returns a key named Id, records, or a value shaped like a record payload.",
  whyNoExecuteSoql:
    "SOQL results are record data. Streaming rows through an LLM defeats the AI-safe positioning this tool exists for. If you need counts, use sandbox_seed_check_row_counts. If you need structure, use sandbox_seed_inspect_object. If you genuinely need rows, use the sf CLI directly — a human-in-the-loop surface where your data isn't being embedded into an LLM context window.",
  contrastWithGeneralPurposeMcps: [
    "salesforcecli/mcp, tsmztech/mcp-server-salesforce, smn2gnt/MCP-Salesforce, and jaworjar95/salesforce-mcp-server all expose execute_soql / run_soql_query and return rows to the model.",
    "Most also expose CRUD/DML and Apex-execute tools.",
    "This server intentionally exposes none of those. It is a seeding-planning tool, not a general-purpose Salesforce agent surface.",
  ],
};

export function checkAiBoundary(): AiBoundaryPayload {
  return AI_BOUNDARY;
}
