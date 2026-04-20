# sandbox-seed

A Salesforce sandbox seeding CLI and MCP server. SOQL-driven org-to-org record copy with automatic dependency-graph walking, cross-org FK remapping, cycle handling, and a mandatory dry-run gate.

**AI-safe by construction.** Record data stays on your machine. The AI — whether it's Claude Code, Cursor, or any MCP host — sees object counts, schema metadata, and file paths. It never sees record payloads. That boundary is enforced in the tool surface, not asked for via prompting.

> **Status: pre-release (0.1.0).** APIs and CLI flags may change before 1.0.

## Why not SFDMU or `sf data import tree`?

| | sandbox-seed | SFDMU | `sf data import tree` |
|---|---|---|---|
| SOQL-typed selection | yes | yes | no (JSON files) |
| Cross-org FK remapping | yes | yes | no |
| Cycle handling (Account↔Contact) | two-phase insert, every SCC | limited | no |
| AI-boundary guarantee | enforced | n/a | n/a |
| Dry-run gate before writes | mandatory | optional | n/a |
| MCP server | yes | no | no |

If you're on a Salesforce DX workflow with an agent in the loop, driving SFDMU through tool calls ends up leaking record IDs into prompt context and miscomposing cycles. sandbox-seed is built for that shape of use from the ground up.

## Install

```
npm i -g sandbox-seed
```

Requires Node.js ≥ 20.

## Quickstart (CLI)

```
sandbox-seed seed \
  --source prod \
  --target dev-full \
  --object Opportunity \
  --where "CloseDate = THIS_QUARTER AND Amount > 50000"
```

The command walks you through: analyze → select → dry-run → run. No writes happen until you confirm after the dry-run.

## Quickstart (MCP)

Add to your `mcp.json` / `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sandbox-seed": {
      "command": "npx",
      "args": ["-y", "sandbox-seed", "--mcp"]
    }
  }
}
```

Then ask your AI assistant something like:

> "Seed my dev sandbox with Opportunities that closed this quarter over $50k."

The model calls the `seed` tool, which walks you through the same analyze/select/dry-run/run flow conversationally.

## Authentication

- Reads `~/.sf/` auth files if you already use the Salesforce CLI (`sf`). Zero config.
- Falls back to an OAuth device flow if you don't have `sf` installed.
- Target must be a sandbox (`Organization.IsSandbox = true`). Writes to production are refused at the tool layer.

## The AI-boundary contract

The single most important property of this tool:

1. SOQL results are read into an on-disk store the tool owns. They do **not** flow back through the MCP / CLI response envelope.
2. Every tool response is metadata only: object names, row counts, relationship graphs, file paths, plan hashes.
3. `WHERE` clauses must be typed by a human. The tool refuses to invent predicates from natural language like "the biggest" or "recent ones" — ambiguity surfaces a prompt asking for a real SOQL predicate.
4. Targets must be sandboxes. Production writes are refused at the tool layer.

The tests in `tests/mcp/` encode these rules. If you're auditing the boundary before putting this in front of customer data, start there.

## Modes

**SF → SF.** Pull from a source org, optionally mask PII, load into a target sandbox.

**Fake → SF.** Generate synthetic records from a YAML recipe. Referentially consistent, schema-aware. Use when you don't have a source org or don't want real data in the sandbox.

## Project status

This is an early public release. File issues for anything that breaks or is unclear. See `REQUIREMENTS.md` for the product spec.

## License

Apache-2.0. See [LICENSE](LICENSE).
