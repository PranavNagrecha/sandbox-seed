# sandbox-seed

> Salesforce sandbox seeding, built for AI agents.
> SOQL-driven org-to-org record copy with automatic dependency-graph walking, cross-org FK remapping, and a hard **AI-never-sees-your-data** boundary.

[![npm](https://img.shields.io/npm/v/sandbox-seed?color=CB3837&label=npm&logo=npm)](https://www.npmjs.com/package/sandbox-seed)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/node/v/sandbox-seed)](package.json)

---

## Why this exists

If you've ever tried to seed a Salesforce sandbox from production through an AI agent, you already know the two problems:

1. **Record IDs don't match across orgs.** Any "just query source, bulk insert target" recipe — whether you wrote it yourself or you're driving [SFDMU](https://github.com/forcedotcom/SFDX-Data-Move-Utility) or `sf data import tree` through tool calls — breaks on FK remapping, circular references like Account↔Contact, and master-detail parent ordering.
2. **Agents see everything they touch.** Running SOQL through a generic MCP or a shell wrapper streams rows straight into your prompt context. Real customer data, real account balances, real PII, all getting embedded into an LLM.

`sandbox-seed` is designed around both:

- A proper dependency-graph walker with two-phase inserts for every strongly-connected component, cross-org ID remapping, and a mandatory dry-run gate before any write.
- A hard boundary in the tool surface itself: **record data never leaves disk**. The AI sees counts, schemas, file paths, and plan hashes. It does not see the rows.

If you're building AI workflows that touch Salesforce, the AI-boundary contract is the property you actually care about, and it's non-negotiable in this tool.

---

## 30-second setup (MCP, the primary surface)

Add this to your MCP host config (`~/.cursor/mcp.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "sandbox-seed": {
      "command": "npx",
      "args": ["-y", "-p", "sandbox-seed", "sandbox-seed-mcp"]
    }
  }
}
```

Restart your host. Then try:

> "Seed my `dev-full` sandbox with Opportunities that closed this quarter over $50k, from the `prod` org."

The model will call the `seed` tool and walk you through the five-step flow (analyze → select → dry-run → confirm → run). No record data ever appears in chat.

**What to expect on first run:**
- `analyze` on a standard object (Case, Opportunity) against a managed-package-heavy org: **30–90 seconds** cold, ~1–3 seconds warm. The delay is one sequential describe per object in the dependency graph (~20–40 describes for Case). Describes cache at `.sandbox-seeding/cache/` with a 24h TTL.
- `extract` rate depends on record count × relationship breadth; small seeds (<500 rows) finish in seconds.
- Sessions live at `~/.sandbox-seed/sessions/` and are garbage-collected after 7 days. The cross-run project id-map at `~/.sandbox-seed/id-maps/` is persistent.

For deeper MCP config, tool reference, and host-specific tips, see [docs/MCP.md](docs/MCP.md).

---

## Install (CLI)

```bash
npm i -g sandbox-seed
```

Requires Node.js ≥ 20.

The CLI currently ships one command — `inspect` — for read-only schema/dependency-graph exploration. Seeding is available through the MCP server (see above); a first-class `sandbox-seed seed` CLI command is on the roadmap.

```bash
sandbox-seed inspect --object Case
sandbox-seed inspect --object Opportunity --include-counts --format mermaid
sandbox-seed inspect --object Account --record-type Partner --target-org prod
```

Full CLI reference: [docs/CLI.md](docs/CLI.md).

---

## The AI-boundary contract

The single most important property of this tool.

1. SOQL results are written to an on-disk session store the tool owns. They **do not** flow back through the MCP response envelope. No tool call ever returns a row.
2. Every tool response is metadata only: object names, row counts, relationship graphs, file paths, plan hashes.
3. `WHERE` clauses must be SOQL typed by a human. The tool refuses to invent predicates from natural language ("the biggest", "recent ones"). Ambiguity surfaces a prompt asking for a real SOQL predicate.
4. Targets must be sandboxes (`Organization.IsSandbox = true`). Writes to production orgs are rejected at the tool layer.

The tests under `tests/mcp/` encode these rules — start there if you're auditing the boundary. Full writeup in [docs/AI_BOUNDARY.md](docs/AI_BOUNDARY.md).

---

## Walkthrough — copy the prompts from a real session

The fastest way to learn this tool is to read a real chat transcript and copy the prompts into your own agent. **[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md)** contains four full verbatim sessions covering:

- A happy-path Case seed (306/308 inserts, 2 target-validation-rule failures)
- A clean 1,271-row run with zero errors
- Three common first-time mistakes the tool catches (full `SELECT` strings, `limit` too low, WHERE matches zero)
- How to ask the agent to describe the tool before you call it

One prompt shape you can paste straight into Cursor, Claude Desktop, or any MCP-aware host:

```
action: "start"
sourceOrg: "<your source alias>"
targetOrg: "<your target sandbox alias>"
object: "Case"
whereClause: "IsClosed = false AND CreatedDate = THIS_YEAR"
sampleSize: 100
disableValidationRulesOnRun: true

USE MCP: sandbox-seed
```

Then for each subsequent step, paste back the JSON the agent suggests:

```json
{ "action": "analyze", "sessionId": "<session-id-from-start>" }
```

```json
{
  "action": "select",
  "sessionId": "<session-id>",
  "includeOptionalParents": ["Account", "Contact"],
  "includeOptionalChildren": ["CaseComment", "Task"]
}
```

```json
{ "action": "dry_run", "sessionId": "<session-id>" }
```

```json
{ "action": "run", "sessionId": "<session-id>", "confirm": true }
```

**Prerequisites:**
1. Salesforce CLI installed (`brew install sfdx-cli` or `npm i -g @salesforce/cli`) and both orgs logged in with `sf org login web --alias <name>`.
2. `sandbox-seed` registered in your MCP host config (see the 30-second setup block above).

### Troubleshooting (from real sessions)

- **"WHERE clause matched 0 records on \<object\>"** — your SOQL matches nothing. Test it in Workbench or `sf data query` first, or relax the filter.
- **"WHERE clause matched N records, exceeding limit M"** — `limit` is a safety cap, not a SOQL `LIMIT`. Either raise `limit`, tighten the predicate, or use `sampleSize: N` (deterministic "first N by `ORDER BY Id`").
- **"sandbox_seed_seed does not take a full SELECT string"** — `whereClause` is the predicate only. Drop the `SELECT … FROM … LIMIT …` parts.
- **`FIELD_CUSTOM_VALIDATION_EXCEPTION` in `execute.log`** — target-org validation rules rejected some rows. Pass `disableValidationRulesOnRun: true` to `start` to snapshot + deactivate them around the insert, then restore.
- **`DUPLICATE_VALUE` on re-run** — you've already seeded those rows. Objects with an external-id field auto-route through UPSERT on re-runs; otherwise run against a clean sandbox.

---

## What's shipped in 0.2.0

- **MCP `seed` tool** — five-step SF → SF copy flow (analyze → select → dry-run → confirm → run) with cross-org FK remapping, two-phase cycle inserts, validation-rule snapshot/restore, and the AI-boundary contract.
- **Child + 1 user-selected lookups** (new in 0.2.0) — at `start`, name specific reference fields on direct children of the root; the walker follows each exactly one hop to pull that target object into scope. Multi-path objects (reachable via direct FK *and* child-lookup) union their ID sets rather than picking one path.
- **Semi-joins in `whereClause` now supported** (fixed in 0.2.0) — root predicates like `Id IN (SELECT … FROM …)` work end-to-end. Root IDs are materialized once and spliced into downstream scopes as literal `Id IN ('…','…')`, sidestepping SOQL's one-level semi-join limit.
- **CLI `inspect` command** — read-only schema and dependency-graph exploration (tree / mermaid / dot / json).
- Salesforce CLI auth integration (reads `~/.sf/`).

Not yet shipped: synthetic data generation, PII masking, CSV import, multi-target fan-out. These are roadmap, not 0.2.0.

### Scope & limitations to know about in 0.2.0

- **One session = one id-map.** The source→target ID map is session-scoped (written to the session dir). Seeds cannot yet be **composed across runs** — if you seed Accounts in one session and then seed Applications in a second session, the second session does not recognize the Accounts from the first. Required lookups are skipped; nillable lookups are inserted as `null`. Workaround: seed everything you need in a single session by rooting the seed on the highest shared object (e.g. Account), so the id-map is populated in dependency order within one run. A project-level id-map that composes across runs is on the roadmap.
- **Child-lookup walking is one hop only, user-selected.** 0.2.0 walks user-named reference fields on direct children exactly one hop further. No transitive expansion, no auto-discovery. If you need a two-hop chain (child → parent → grandparent), root the seed on the child instead so its parents are walked transitively.
- **Ownership and queue/group lookups default to the target user.** References to `User`, `Group`, or `Queue` (most commonly `OwnerId`, but also fields like `AssignedToId` or `QueueId`) are **not** walked into the dependency graph, because those records are org-global, often privileged, and rarely safe to materialize cross-org. At run time these fields are left `null` on insert, which causes Salesforce to default them to the target-org user performing the seed. The dry-run report surfaces a **"Defaulted owner/user/group references"** count per object so you can see how many rows this affects before running. If you need to preserve specific owners, set them manually in the target after seeding, or pre-populate the id-map with explicit User mappings.

---

## Authentication

- Reads `~/.sf/` auth files if you already use the Salesforce CLI (`sf`). Zero config.
- Falls back to an OAuth device flow if you don't have `sf` installed.
- Target org must be a sandbox. Production targets are refused.

More: [docs/AUTH.md](docs/AUTH.md).

---

## Status

Pre-release (`0.2.0`). APIs and flags may change before `1.0`. Use in sandboxes only — **never** point this at a production org as the target (the tool refuses, but don't test the refusal with real money).

Roadmap: [BACKLOG in project notes, soon to be moved into GitHub Issues].

---

## Documentation

- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — what the tool **doesn't** do today (read before adopting)
- [docs/MCP.md](docs/MCP.md) — MCP server setup, tool reference, host-specific notes
- [docs/CLI.md](docs/CLI.md) — CLI command reference
- [docs/AI_BOUNDARY.md](docs/AI_BOUNDARY.md) — the boundary contract, in depth
- [docs/AUTH.md](docs/AUTH.md) — authentication setup
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the dependency graph, SCC handling, and FK remapping work
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, tests, release flow

---

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup.

Security issues: please do **not** file public issues. Email [pranav.nagrecha11@gmail.com](mailto:pranav.nagrecha11@gmail.com).

---

## License

[Apache-2.0](LICENSE). © 2026 Pranav Nagrecha.
