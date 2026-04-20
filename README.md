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

## How it compares

|  | sandbox-seed | SFDMU | `sf data import tree` |
|---|---|---|---|
| Input model | SOQL predicate | YAML config | JSON + object files |
| Cross-org FK remapping | ✓ | ✓ | ✗ |
| Cycle handling (two-phase insert per SCC) | ✓ | limited | ✗ |
| Master-detail parent ordering | ✓ | ✓ | ✗ |
| AI-boundary guarantee | ✓ enforced at tool layer | n/a | n/a |
| Dry-run gate before writes | mandatory | optional | n/a |
| MCP server | ✓ | ✗ | ✗ |
| Fully local execution (no cloud) | ✓ | ✓ | ✓ |

`sandbox-seed` is *not* a generic Salesforce DX plugin — it doesn't install under `sf`, doesn't compete with CLI plugins that have different jobs. It's a focused tool for one thing: seeding sandboxes safely, with AI in the loop.

---

## What's shipped in 0.1.0

- **MCP `seed` tool** — five-step SF → SF copy flow (analyze → select → dry-run → confirm → run) with cross-org FK remapping, two-phase cycle inserts, validation-rule snapshot/restore, and the AI-boundary contract.
- **CLI `inspect` command** — read-only schema and dependency-graph exploration (tree / mermaid / dot / json).
- Salesforce CLI auth integration (reads `~/.sf/`).

Not yet shipped: synthetic data generation, PII masking, CSV import, multi-target fan-out. These are roadmap, not 0.1.0.

---

## Authentication

- Reads `~/.sf/` auth files if you already use the Salesforce CLI (`sf`). Zero config.
- Falls back to an OAuth device flow if you don't have `sf` installed.
- Target org must be a sandbox. Production targets are refused.

More: [docs/AUTH.md](docs/AUTH.md).

---

## Status

Pre-release (`0.1.0`). APIs and flags may change before `1.0`. Use in sandboxes only — **never** point this at a production org as the target (the tool refuses, but don't test the refusal with real money).

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
