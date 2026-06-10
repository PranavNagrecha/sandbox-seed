# CLI reference

```bash
npm i -g sandbox-seed
sandbox-seed --help
```

The CLI exposes two command groups:

- `inspect` — read-only schema and dependency-graph exploration.
- `seed` (+ `seed resume`, `seed recover`) — the full seeding flow, driving the **same engine and safety gates** as the MCP `seed` tool: the target must be a sandbox, a dry run always precedes the run, the plan hash is verified, and the run only executes after explicit confirmation.

---

## `sandbox-seed seed`

Seed a sandbox from another org: SOQL-scoped root records + their dependency graph, with cross-org FK remapping. One invocation drives start → analyze → select → dry run → confirm → run.

### Usage

```
sandbox-seed seed --source-org <alias> --target-org <sandbox-alias> --object <sObject> --where "<SOQL predicate>" [flags]
```

### Required

| Flag | Description |
|---|---|
| `--source-org` | Source org alias (from `sf org login`) |
| `--target-org` | Target **sandbox** alias. Production targets are refused. |
| `--object` | Root sObject API name to seed |
| `--where` | SOQL WHERE clause (predicate only — no `SELECT`/`LIMIT`) scoping the root records |

### Scope flags

| Flag | Default | Description |
|---|---|---|
| `--limit` | `10000` | Safety cap on the root-scope count — refuses if WHERE matches more |
| `--sample-size` | | Take the first N matching root records (`ORDER BY Id`) instead of refusing |
| `--include-parents` | | Optional parent objects to include (comma-separated, repeatable) |
| `--include-children` | | Optional child objects to include (comma-separated, repeatable) |
| `--include-managed-packages` | off | Surface managed-package objects in the optional lists |
| `--include-system-children` | off | Surface system-automation children (Feed*, *History, …) |
| `--child-lookup` | | Walk lookup fields on a direct child one hop: `Child:Field1[,Field2]` (repeatable) |

### Run-behavior flags

| Flag | Default | Description |
|---|---|---|
| `--disable-validation-rules` | off | Snapshot + deactivate target-org validation rules around the insert, then restore |
| `--isolate-id-map` | off | Ignore the persistent project id-map for this run |
| `--upsert-key` | | Force an upsert key: `Object=ExternalIdField` (repeatable) |
| `--mask` | off | Mask detected sensitive fields with deterministic, format-preserving fakes |
| `--mask-field` | | Masking override: `Object.Field[:strategy]` — strategies `email`, `phone`, `person-name`, `street-address`, `generic-text`, `auto`, `copy` (opt-out). Implies `--mask`. Repeatable |

### Flow control

| Flag | Default | Description |
|---|---|---|
| `--dry-run-only` | off | Stop after the dry run; execute later with `seed resume <sessionId>` |
| `--yes` / `-y` | off | Skip the interactive confirmation (CI). Without a TTY, `--yes` is **required** to run |
| `--json` | off | Emit the step summaries as JSON on stdout (prompts go to stderr) |

### Examples

```bash
# Interactive: dry run, review, confirm at the prompt
sandbox-seed seed --source-org prod --target-org dev-full \
  --object Case --where "IsClosed = false AND CreatedDate = THIS_YEAR" --sample-size 100

# Masked seed, stop at the report, run later after review
sandbox-seed seed --source-org full --target-org dev-sandbox \
  --object Contact --where "CreatedDate = THIS_MONTH" --mask --dry-run-only
sandbox-seed seed resume <sessionId>

# CI: explicit non-interactive confirmation
sandbox-seed seed --source-org prod --target-org qa \
  --object Account --where "Industry = 'Education'" --include-children Contact,Opportunity --yes --json
```

### Exit codes

Same taxonomy as the rest of the CLI: `0` success, `1` user error **or declined confirmation**, `2` auth, `3` Salesforce API, `4` internal.

---

## `sandbox-seed seed resume <sessionId>`

Execute a session that already has a dry run (e.g. created with `--dry-run-only`, or one you declined at the prompt). The engine enforces dry-run freshness and the plan hash — if the plan drifted since the report you reviewed, the run refuses. Pass `--refresh-dry-run` to re-run the dry run first; `--yes` to skip the prompt.

## `sandbox-seed seed recover <sessionId>`

Reactivate target-org validation rules a crashed run left deactivated. The engine refuses all new seed work while a recovery is pending — this clears it.

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
