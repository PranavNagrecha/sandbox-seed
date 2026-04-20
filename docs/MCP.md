# MCP server reference

`sandbox-seed` ships an MCP server that exposes the seeding workflow to AI agents (Claude Desktop, Claude Code, Cursor, Continue, Windsurf, and any other MCP host).

The MCP surface is the **primary** interface for seeding. The CLI today only does read-only inspection — see [CLI.md](CLI.md).

---

## Setup

### 1. Install

```bash
npm i -g sandbox-seed
```

This installs two binaries on your `PATH`:
- `sandbox-seed` — the CLI
- `sandbox-seed-mcp` — the MCP server (stdio transport)

### 2. Register with your MCP host

Drop this block into your host's MCP config:

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

If you've installed the package globally, you can simplify to:

```json
{
  "mcpServers": {
    "sandbox-seed": {
      "command": "sandbox-seed-mcp"
    }
  }
}
```

### Where the config lives

| Host | Config path |
|---|---|
| **Cursor** (global) | `~/.cursor/mcp.json` |
| **Cursor** (per-project) | `<project>/.cursor/mcp.json` |
| **Claude Desktop** (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop** (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Code** (per-project) | `<project>/.mcp.json` |
| **Continue** | `~/.continue/config.json` (under `experimental.modelContextProtocolServers`) |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |

### 3. Restart your host

Most hosts only load MCP config at startup. Restart the app fully (not just the chat).

### 4. Verify

In a new conversation, ask:

> "What MCP tools do you have for sandbox-seed?"

The model should mention a `seed` tool. If it doesn't, see [Troubleshooting](#troubleshooting) below.

---

## Tool reference

The MCP surface is intentionally minimal: **one** action-dispatched tool. The host model calls it five times in sequence to complete a seed.

### `seed` (action-dispatched)

| Parameter | Type | When required | Notes |
|---|---|---|---|
| `action` | enum: `start` \| `analyze` \| `select` \| `dry_run` \| `run` \| `recover_validation_rules` | always | Step in the flow |
| `sessionId` | string | analyze, select, dry_run, run | Returned by `start` |
| `sourceOrg` | string (alias) | start | From `sf org login` |
| `targetOrg` | string (alias) | start | Must be a sandbox |
| `object` | string (sObject API name) | start | Root object to seed |
| `whereClause` | string (SOQL predicate) | start | **Must be typed by a human.** Tool refuses to run on invented predicates. |
| `limit` | int > 0 | optional (start) | Safety cap on root scope. Default 200. |
| `sampleSize` | int > 0 | optional (start) | Take first N matching records (ORDER BY Id) instead of rejecting on too-many |
| `includeOptionalParents` | string[] | select | Names of optional parents to include |
| `includeOptionalChildren` | string[] | select | Names of optional children to include |
| `includeManagedPackages` | bool | optional (analyze) | Default false — managed-package parents/children are noisy |
| `includeSystemChildren` | bool | optional (analyze) | Default false — Feed*, *History, ProcessInstance etc. |
| `disableValidationRulesOnRun` | bool | optional (start) | If true, snapshot + deactivate + reactivate target-org validation rules around the run. See [recovery](#validation-rule-recovery). |
| `confirm` | literal `true` | run | The final confirmation gate — `run` rejects without it |

### The five-step flow

1. **`start`** — declares the seed scope. Validates the SOQL predicate against the source org, checks the count vs `limit`/`sampleSize`, verifies the target is a sandbox, returns a `sessionId`.
2. **`analyze`** — walks the dependency graph from the root object. Returns:
   - **must-include parents** — required references the tool will copy automatically
   - **optional parents** — references you can opt into
   - **optional children** — children you can opt into
3. **`select`** — you (the user) tell the model which optional parents/children to include. The model passes those names back as `includeOptionalParents` / `includeOptionalChildren`.
4. **`dry_run`** — **mandatory** before any write. Extracts records, computes the FK remap, simulates the insert order, writes a plan + counts to disk, returns the file path. No writes happen.
5. **`run`** — actual write. Requires `confirm: true`. Executes two-phase inserts for any cycle SCC, remaps cross-org IDs, reports counts. Still returns no record data.

```
start ─┐
       ├─ sessionId ──> analyze ─┐
                                 ├─ parents/children ──> select ─┐
                                                                 ├─ scope ──> dry_run ─┐
                                                                                       ├─ plan ──> run (confirm:true)
```

### What the tool returns

Every response shape:

```json
{
  "ok": true,
  "action": "<which action you called>",
  "summary": { /* metadata only — counts, names, file paths */ },
  "nextAction": "<which action to call next, or null>",
  "guidance": "<plain-English next-step instructions for the model>"
}
```

`summary` never contains record data. If you ever see field values in this object, that's a bug — please file an issue.

---

## `playbook` (chain multiple seeds)

For repeatable multi-step flows (e.g. "after every sandbox refresh, seed Accounts → Contacts → Opps → Tasks"), register a YAML playbook and run it through the `playbook` tool.

### Where playbooks live

**User scope only.** Playbooks are read from `~/.sandbox-seed/playbooks/<name>.yml`. There is no project-scoped or team-scoped playbook directory by design — playbooks describe workstation-level workflows, not repo content.

### Schema

```yaml
apiVersion: sandbox-seed/v1
kind: Playbook
name: demo-refresh
description: Seed the dev-full sandbox with a week's worth of real activity.
defaults:
  sourceOrg: prod
  targetOrg: dev-full
  disableValidationRulesOnRun: true
steps:
  - name: accounts
    object: Account
    whereClause: CreatedDate = LAST_N_DAYS:7
    limit: 200
  - name: contacts
    object: Contact
    whereClause: Account.CreatedDate = LAST_N_DAYS:7
    limit: 500
  - name: opportunities
    object: Opportunity
    whereClause: CloseDate = THIS_QUARTER AND Amount > 50000
    continueOnError: true
```

Every field on a step is the same shape the `seed` tool accepts at `start` — `object`, `whereClause`, `limit`, `sampleSize`, `includeOptionalParents`, `includeOptionalChildren`, `childLookups`, `disableValidationRulesOnRun`, `isolateIdMap`. Step-level fields override `defaults`. See [src/playbook/types.ts](../src/playbook/types.ts) for the full schema.

`continueOnError: true` on a step means a failure logs and proceeds to the next step. Default is abort-on-first-error so the user can fix and re-run from a known state.

### Actions

| Action | Args | What it does |
|---|---|---|
| `list` | (none) | Enumerate playbooks under `~/.sandbox-seed/playbooks/`, report any parse errors |
| `dry_run` | `name` | Drive every step through `start → analyze → select → dry_run`, write ONE aggregated report, return a `playbookRunId` |
| `run` | `playbookRunId`, `confirm: true` | Execute every step in order against its saved session. Refuses without a recent (< 24h) dry-run |

Cross-step FK stitching happens automatically via the persistent project-level id-map at `~/.sandbox-seed/id-maps/<source>__<target>.json`. If step 1 seeds Accounts and step 2 seeds Contacts with a lookup to Account, step 2's Contact inserts resolve to the Account target IDs that step 1 just produced.

The aggregated dry-run report is at `~/.sandbox-seed/playbook-runs/<playbookRunId>/aggregated-dry-run.md`, with per-step session reports still living under `~/.sandbox-seed/sessions/<sessionId>/`. The MCP response references these by path only — no record data in the envelope.

### Example flow

```json
{ "action": "list" }
```
→ returns available playbook names.

```json
{ "action": "dry_run", "name": "demo-refresh" }
```
→ returns `playbookRunId` and `aggregateReportPath`. Review the report.

```json
{ "action": "run", "playbookRunId": "<id>", "confirm": true }
```
→ executes every step.

---

## Validation-rule recovery

When you call `start` with `disableValidationRulesOnRun: true`, the `run` step:

1. Snapshots which target-org validation rules are currently `Active=true`.
2. Deactivates them.
3. Performs the seed.
4. Reactivates only the rules that were active in the snapshot.

If the process crashes between steps 2 and 4, the next tool call **refuses new work** until you run:

```
{ "action": "recover_validation_rules", "sessionId": "<the-broken-session-id>" }
```

This is a deliberate safety gate. The tool will not let you accidentally leave validation rules disabled in a sandbox.

---

## Hard rules the tool enforces

These are not "best practices" — they are tool-layer rejections.

| Rule | What happens if violated |
|---|---|
| `whereClause` must be SOQL | Tool returns `BadRequest`; model is instructed to ask the user |
| Target must be a sandbox | Tool returns `ProductionTargetRefused` |
| `dry_run` before `run` | `run` refuses without a prior dry-run for the session |
| `confirm: true` on `run` | Refused without explicit confirmation |
| Validation rules left disabled | Next call refuses until `recover_validation_rules` |

---

## What the AI never sees

- Record field values
- Record IDs (source or target)
- Anything from the SOQL result set beyond `COUNT()`

What it does see:
- Object names (e.g., `Opportunity`, `Account`)
- Counts (e.g., `120 root records, 87 must-include parents`)
- Schema metadata (field names, types, relationships)
- File paths to plan / report / extract files on **your** disk
- Plan hashes (for verifying the plan it dry-ran is the plan it's about to run)

Full writeup: [AI_BOUNDARY.md](AI_BOUNDARY.md).

---

## Troubleshooting

### "The model never calls the tool"

This is a known behavior in some hosts (especially Cursor) — the model needs strong textual signals to route to an MCP tool. Try:

1. **Mention "sandbox-seed" or "MCP" explicitly** in your prompt the first time.
2. **Use trigger phrases** the tool description recognizes: "seed", "copy records to sandbox", "migrate Opportunities to dev".
3. **Check tool count** in your host. Cursor caps at ~40 tools across all servers — if you're over, `sandbox-seed` may be silently dropped.
4. **Restart the host** if you just edited `mcp.json`.

### "Authentication error"

The MCP server reads from `~/.sf/` (Salesforce CLI) by default. Make sure you've authenticated to both source and target orgs:

```bash
sf org login web --alias prod
sf org login web --alias dev-full
```

See [AUTH.md](AUTH.md) for details and the OAuth-device-flow fallback.

### "It says the target isn't a sandbox"

The tool checks `Organization.IsSandbox = true` on the target. If you're trying to seed into production, **don't** — there is no override. If your sandbox is incorrectly identified as production, check the org's metadata.

### "stdio JSON parse error" / weird host crashes

The MCP transport is stdio-based. Anything written to `stdout` other than valid JSON-RPC corrupts the channel. If you're hacking on the server, never `console.log` — use `console.error` (stderr is fine).

### "INVALID_SESSION_ID" or "Token expired" mid-run

The Salesforce access token in `~/.sf/` expired while the seed was executing. The tool does not refresh mid-run. Re-login (`sf org login web --alias <name>`) for whichever org errored, then re-invoke the flow. If the error fired during `run`, the session's already-inserted rows are preserved in the project id-map, so re-running the same session picks up where it stopped (upsert-keyed objects match-and-update; non-keyed objects skip via cross-run dedup).

### `INVALID_CROSS_REFERENCE_KEY` on insert

Usually one of three causes. Check `execute.log` — the tool annotates this specific error with suspected causes.

1. **Stale project id-map entry.** A prior run seeded a target row; that row has since been deleted out-of-band (manual cleanup, a partial sandbox refresh, another data loader). The map still points at the dead target id. `execute.log` surfaces the specific `projectMap[<object>:<sourceId>]→<targetId>` entries that are suspect. Recovery: re-run with `isolateIdMap: true` once to rebuild the map against the current target state.
2. **Unmapped standard-root FK** (OwnerId, unmapped RecordTypeId, BusinessHoursId). The tool omits these on insert by default so Salesforce's default-picker fills them, but a picklist-strict org can still reject. Solution: pre-populate the id-map with an explicit mapping.
3. **Cycle phase 2 PATCH failure.** Happens when the break-edge target record insert itself failed. Fix the underlying phase-1 error first.

### `DUPLICATE_VALUE` on re-run

The object has no upsert key configured, and the target rows (matched by some unique field the source defines) already exist from a prior seed. Two paths:

- **Give it an upsert key.** Set an external-id field on the object in the target org's schema and populate it in source. The tool auto-routes objects with a picked upsert key through composite UPSERT (match-and-update) rather than INSERT.
- **Clean the target.** Run against a fresh sandbox or delete the duplicate rows.

### `MALFORMED_QUERY` from your WHERE clause

User-typed SOQL syntax error — the predicate didn't validate against the source org. Test it in Workbench or `sf data query --query "SELECT Id FROM <object> WHERE <your-clause>"` before calling the tool.

### Plan-hash mismatch on `run`

The `dry_run` you ran earlier produced a plan hash the tool verifies before `run` executes. If the hash doesn't match, something changed between the two (different scope, different `includeOptional*`, re-ran dry_run with different args). The fix is always the same: re-run `dry_run` with your current intended args, then `run` against that fresh hash.

### Session accumulation / first-run latency

Sessions live at `~/.sandbox-seed/sessions/` and are GC'd after 7 days. If you run dozens per day, expect the directory to grow — the GC catches up. To clear everything manually: `rm -rf ~/.sandbox-seed/sessions`.

Cold-run `analyze` against a managed-package-heavy org is slow (30–90s) because describes are sequential. The describe cache at `.sandbox-seeding/cache/` (repo-root by default) has a 24h TTL — subsequent analyses are near-instant.

### Composite insert returned `ok: true` but per-row errors

The composite endpoint responds 200 OK even when individual rows fail. The tool counts these into the `errors` bucket, but the overall action reports `ok: true` because the *call* succeeded. Always read `execute.log` for per-row results — the summary counts are accurate but not the whole story.

### Sandbox refresh invalidated my project id-map

Every run snapshots the target's `Organization.Id` and `LastRefreshDate` into `<source>__<target>.meta.json`. If either changes between runs, the map is archived to `<file>.stale-<timestamp>.org-refresh.json` (or `.org-mismatch.json`) and load returns empty. The archive is kept for postmortem — delete it when you're sure you don't need it.

---

## Versioning

The MCP tool surface follows semver. Breaking changes to action names, parameter shapes, or response envelopes will only happen in major versions. Pin if you rely on a specific shape.
