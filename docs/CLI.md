# CLI reference

```bash
npm i -g sandbox-seed
sandbox-seed --help
```

The CLI today exposes one command: `inspect` — read-only schema and dependency-graph exploration. Seeding itself is currently MCP-only; see [MCP.md](MCP.md). A first-class `sandbox-seed seed` command is on the roadmap.

---

## `sandbox-seed inspect`

Inspect one Salesforce object's dependency neighborhood: transitive parents + 1-level children. Read-only by default — no SOQL, no writes.

### Usage

```
sandbox-seed inspect --object <sObject> [flags]
```

### Required

| Flag | Short | Description |
|---|---|---|
| `--object` | `-s` | Single root sObject API name to focus on |

### Common flags

| Flag | Short | Default | Description |
|---|---|---|---|
| `--target-org` | `-o` | (sf default) | Org alias from `sf org login` |
| `--record-type` |  |  | Record-type developer name; scopes required-field analysis on the root |
| `--parent-depth` |  | `2` | Max transitive parent walk depth. Stops at standard root objects regardless. |
| `--children` |  | on | Walk 1 level of children via childRelationships. Use `--no-children` to skip. |
| `--include-counts` |  | off | Run `SELECT COUNT()` per walked object (aggregate metadata only — no record data) |
| `--include-formula` |  | off | Include formula/calculated/auto-number fields (excluded by default) |
| `--include-audit` |  | off | Include audit fields (CreatedById/Date, LastModified, SystemModstamp, …) |
| `--include-non-createable` |  | off | Include non-createable fields (read-only / system-managed) |

### Output flags

| Flag | Short | Default | Description |
|---|---|---|---|
| `--format` |  | `tree` | `tree` \| `mermaid` \| `dot` \| `json` |
| `--output` | `-f` |  | Write to file instead of stdout |
| `--max-nodes` |  | `100` | Maximum nodes to render. `0` = no cap. |
| `--focus` |  |  | Focus rendering on this object and its neighbors (subgraph view) |
| `--depth` |  | `2` | With `--focus`: neighborhood depth |

### Cache & API

| Flag | Default | Description |
|---|---|---|
| `--api-version` | `60.0` | Salesforce API version |
| `--cache-ttl` | `86400` | Describe cache TTL in seconds |
| `--no-cache` |  | Bypass describe cache; fetch everything fresh |
| `--verbose` |  | Verbose logging: cache hits, API calls, timings |

### Examples

```bash
# Quickest possible look at Case
sandbox-seed inspect --object Case

# Mermaid diagram for a doc
sandbox-seed inspect --object Case --target-org dev-sandbox --format mermaid

# Required-field analysis scoped to a record type
sandbox-seed inspect --object Account --record-type Partner --include-counts

# Tighter parent walk, no children
sandbox-seed inspect --object Opportunity --no-children --parent-depth 3

# Save a JSON snapshot
sandbox-seed inspect --object Case --format json --output case-graph.json

# Focus on a subgraph in a noisy schema
sandbox-seed inspect --object Account --focus Contact --depth 2
```

### What it doesn't do

- No record data is read unless you pass `--include-counts` (and even then, only `COUNT()`).
- No writes, ever.
- No FK remapping or seeding — that's the MCP `seed` tool.

For the seeding workflow, see [MCP.md](MCP.md).
