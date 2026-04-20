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

---

## Versioning

The MCP tool surface follows semver. Breaking changes to action names, parameter shapes, or response envelopes will only happen in major versions. Pin if you rely on a specific shape.
