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

## Walkthrough — from zero to a seeded sandbox

A full copy-paste guide for someone who has never used this tool before. Assumes you have a source org (e.g. production) and a target sandbox.

### Step 1 — Install the Salesforce CLI and log in to both orgs

If you don't already have `sf`:

```bash
# macOS
brew install sfdx-cli

# Windows / Linux
npm i -g @salesforce/cli
```

Then log in to both the **source** org (where the data lives) and the **target** sandbox (where it's going):

```bash
sf org login web --alias prod-source
sf org login web --alias dev-target
```

Each command opens a browser; finish the Salesforce login and close the tab. Verify both aliases are registered:

```bash
sf org list
```

![sf org list output](docs/screenshots/01-sf-org-list.png)
<!-- SCREENSHOT TO ADD: terminal output of `sf org list` showing both aliases -->

### Step 2 — Add `sandbox-seed` to your AI host

Pick your MCP host below and paste the config block. Restart the host after saving.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%AppData%\Claude\claude_desktop_config.json` (Windows):

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

**Cursor** — `~/.cursor/mcp.json` — use the same block.

**Project-scoped (any host)** — drop it in `.mcp.json` at your project root.

![MCP config pasted in Claude Desktop](docs/screenshots/02-mcp-config.png)
<!-- SCREENSHOT TO ADD: the config file open in an editor with the sandbox-seed block highlighted -->

### Step 3 — Ask the agent to seed

Once the host is restarted, ask the model a concrete question. **Write your own SOQL WHERE clause** — the tool refuses to invent predicates from natural language, so vague prompts get sent back for a real SOQL snippet.

> "Seed `dev-target` from `prod-source` with the Account whose Id is `0011x00000ABCdEFGHI`. Include all direct-child Contacts and Opportunities."

Or with a filtered WHERE:

> "Seed `dev-target` from `prod-source`. Root object: `Opportunity`. WHERE clause: `CloseDate = LAST_QUARTER AND Amount > 50000`. Sample size: 100."

The agent will walk the five-step flow (`analyze` → `select` → `dry_run` → `run`) one tool call at a time. You only need to confirm at two points:

1. **After `select`** — the agent proposes which optional child and parent objects to include. You accept, edit, or reject.
2. **After `dry_run`** — you read the dry-run report (path printed in chat), verify the counts, then say "run it" to trigger the actual inserts.

![Agent calling seed tool in Claude Desktop](docs/screenshots/03-agent-seed-flow.png)
<!-- SCREENSHOT TO ADD: Claude Desktop transcript showing the agent invoking `seed` with stage indicators -->

### Step 4 — Review the dry-run report before confirming

The dry-run report lives on your disk (the AI never sees it). The path is printed in chat. Open it:

```bash
# macOS
open ~/.sandbox-seed/sessions/<session-id>/dry-run.md

# or just cat it
cat ~/.sandbox-seed/sessions/<session-id>/dry-run.md
```

It contains: per-object record counts, the SOQL that will be executed, the list of target-org schema differences that will be auto-skipped, and the first 100 source record Ids. Verify the counts match what you expect **before** telling the agent to run.

![Dry-run report opened in an editor](docs/screenshots/04-dry-run-report.png)
<!-- SCREENSHOT TO ADD: dry-run.md open in an editor, scope-summary table visible -->

### Step 5 — Run it

Tell the agent:

> "Looks good, run it."

The `run` tool call does the actual inserts, writing a detailed log per record. The agent reports a count of successes and failures; failures are in the log path it prints.

```bash
cat ~/.sandbox-seed/sessions/<session-id>/execute.log
```

![Run complete summary in chat](docs/screenshots/05-run-complete.png)
<!-- SCREENSHOT TO ADD: Claude Desktop showing "Run complete with N inserted, M errors" -->

### Troubleshooting

- **"WHERE clause returned 0 records"** — your SOQL matches nothing. Test it in Workbench or with `sf data query --query "SELECT COUNT() FROM …"` first.
- **"Target org must be a sandbox"** — you pointed the target at production. The tool refuses. Use a sandbox.
- **Field validation errors in `execute.log`** — target-org validation rules rejected some rows (required fields, picklist values, etc.). Pass `disableValidationRules: true` to `run` to snapshot + deactivate them around the insert, then restore.
- **`DUPLICATE_VALUE` errors on re-run** — you've already seeded those rows. If the object has an external-id field, the tool auto-picks UPSERT; otherwise run against a clean sandbox.

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
