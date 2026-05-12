# The AI-boundary contract

The single most important property of `sandbox-seed`. Every other design choice is downstream of this.

> **Record data never leaves your disk.** The AI sees object names, counts, schemas, file paths, and plan hashes. It does not see rows, fields, or IDs from the source org.

This is not a guideline. It is an enforced contract in the tool surface.

---

## What this means in practice

When you ask Claude / Cursor / any MCP-host model to seed a sandbox:

- The model calls the `seed` tool over MCP.
- The tool reads SOQL results into an on-disk session store **owned by the tool**, in `~/.sandbox-seed/sessions/<sessionId>/`.
- The MCP response envelope contains only metadata: object names, counts, relationship graphs, file paths.
- The model can reason about *what was extracted* (counts, structure, expected target shape).
- The model cannot read *what's inside* the extract files unless you, the human, explicitly hand them over.

There is no flag to disable this. It is structural.

---

## Why this matters

Three concrete failure modes this prevents:

### 1. Prompt context contamination

Generic "query Salesforce → bulk insert" recipes through MCP shells stream rows back as tool output. That output becomes part of the model's context window, which means:
- Real customer data is now in your conversation history.
- It may be cached by the model provider (Anthropic, OpenAI, etc.) according to their data-handling policies.
- It can be paraphrased or surfaced in subsequent turns.
- A screenshot of your IDE leaks PII.

`sandbox-seed` short-circuits this. Rows go to disk; they don't pass through the LLM.

### 2. Cross-tenant leakage in shared agents

If you're building an agent product that touches multiple customers' Salesforce orgs, you cannot have one customer's rows showing up in another customer's prompt context. The boundary makes this structurally impossible — the AI never had the rows to leak.

### 3. Audit and compliance

For SOC 2, HIPAA, GDPR, and most enterprise procurement reviews, "the AI doesn't see the data" is the answer auditors want. With `sandbox-seed`, you can point at the test suite (`tests/mcp/ai-boundary.test.ts`) as the literal enforcement mechanism, not a policy promise.

---

## What the AI does see

| Surface | Value | Example |
|---|---|---|
| Object names | yes | `Opportunity`, `Account`, `Contact` |
| Row counts | yes | `120 root records, 87 must-include parents` |
| Schema metadata | yes | field names, types, relationships, picklist values |
| Relationship graph | yes | which objects reference which |
| File paths | yes | `~/.sandbox-seed/sessions/abc123/extract/Account.json` |
| Plan hash | yes | `sha256:7a9c…` (so the model can verify dry-run plan == run plan) |
| Field values | **no** | — |
| Record IDs (source) | **no** | — |
| Record IDs (target, post-insert) | **no** | — |
| SOQL result rows | **no** | — |

---

## The four hard rules

These are tool-layer rejections. The model cannot bypass them by asking nicely.

### 1. SOQL results never appear in tool responses

Every response from the `seed` tool is shape-constrained. The `summary` field is a record of metadata. Returning row data from a tool call is a bug — and a tested-against bug. See [tests/mcp/ai-boundary.test.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/tests/mcp/ai-boundary.test.ts).

### 2. WHERE clauses must be SOQL typed by a human

The tool refuses to invent predicates from natural language. If you ask the model "seed the biggest Opportunities", the model is instructed (via tool description) to ask you for a real SOQL predicate like `Amount > 100000` before calling the tool. Vague predicates are rejected by the source org's SOQL validator anyway.

This prevents silent over-scoping ("the biggest" → 50,000 rows) and silent under-scoping.

#### Date-literal pitfall: `THIS_YEAR` combined with `> TODAY`

A WHERE clause like `MyDate__c = THIS_YEAR AND MyDate__c > TODAY` is upper-bounded by the calendar year — and on orgs with multi-year future dates (universities, real estate, project plans) most future-dated rows are 2027+ and fall *outside* `THIS_YEAR`. The result is a scope count much smaller than "all future records" reads as.

Prefer:

- `MyDate__c >= TODAY` (unbounded forward), or
- An explicit range: `MyDate__c >= 2026-01-01 AND MyDate__c <= 2026-12-31`.

Same caveat for `THIS_MONTH`, `THIS_QUARTER`, `THIS_FISCAL_YEAR`, etc. when combined with a forward bound. The tool will surface the scope count on `start` — sanity-check it against your intuition before continuing to `dry_run`.

### 3. Targets must be sandboxes

Before any write, the tool calls `Organization.IsSandbox` on the target. If false, the operation is refused with `ProductionTargetRefused`. There is no override flag. Production-target writes are tested-against in [tests/mcp/seed-boundary.test.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/tests/mcp/seed-boundary.test.ts).

### 4. `dry_run` is mandatory before `run`

The `run` action refuses without a prior `dry_run` for the same `sessionId`. The dry-run writes a plan file with a hash; the run verifies the hash. This means:
- The user has had a chance to review the plan on disk.
- The model can't "just run it" without a dry-run.
- Any mid-flow change (e.g., the model re-decides which optional parents to include) requires a fresh dry-run.

---

## Where the boundary is enforced in code

If you're auditing this, here's what to read:

| Concern | File |
|---|---|
| Tool response shape (no record data leaks here) | `src/mcp/server.ts`, `src/mcp/tools/seed.ts` |
| AI-boundary test suite | `tests/mcp/ai-boundary.test.ts` |
| Sandbox-only target enforcement | `tests/mcp/seed-boundary.test.ts` |
| Dry-run-before-run gate | `tests/seed/dry-run-gate.test.ts` |
| Session store (where rows actually live) | `src/seed/session.ts`, `src/seed/extract.ts` |

If you find a path where record data flows through the MCP envelope, that's a security bug. Report it privately to [pranav.nagrecha11@gmail.com](mailto:pranav.nagrecha11@gmail.com).

---

## What this is *not*

- **Not encryption.** The on-disk session store is plain JSON. Treat it like any other local data — same threat model as your `.sf/` auth files.
- **Not a guarantee about the source org.** This tool can't stop you from running other queries through other tools. It only guarantees that *its own* tool calls don't expose row data to the AI.
- **Not a bypass for least-privilege auth.** If your Salesforce user can see the data, the tool can extract it. Use a scoped integration user when seeding.
- **Not a substitute for masking.** The data on disk is real. If you load it into a sandbox, the sandbox now contains real data. Sandboxes generally have weaker access controls than prod — plan for that. PII masking is on the roadmap.
- **Not immune to out-of-band target deletions.** The persistent project id-map at `~/.sandbox-seed/id-maps/` caches source→target ID pairs across runs. If a target row is deleted outside this tool (manual cleanup, another data loader, a partial sandbox refresh the tool didn't observe), the map still claims the row exists and the next run that FKs to it will fail with `INVALID_CROSS_REFERENCE_KEY`. When this happens, `execute.log` flags the specific stale entries and suggests re-running with `isolateIdMap: true` once to rebuild the map from scratch.

---

## What's on disk

The boundary keeps record data out of the AI's context window. It does **not** encrypt anything on your workstation. Every artifact below is plain JSON / plain text, readable by any process running as you.

| Path | Contains | Scope |
|---|---|---|
| `~/.sandbox-seed/sessions/<sessionId>/extract/*.json` | full source records for objects in scope (every field the tool queried) | per-session; GC'd after 7 days |
| `~/.sandbox-seed/sessions/<sessionId>/id-map.json` | source→target ID pairs produced by this session | per-session; GC'd after 7 days |
| `~/.sandbox-seed/sessions/<sessionId>/execute.log` | per-row insert/upsert results, source IDs, Salesforce error messages | per-session; GC'd after 7 days |
| `~/.sandbox-seed/sessions/<sessionId>/dry-run.md` | plan details including record IDs and SOQL | per-session; GC'd after 7 days |
| `~/.sandbox-seed/id-maps/<source>__<target>.json` | source→target ID pairs accumulated across runs | persistent; per (sourceAlias, targetAlias) pair |
| `.sandbox-seeding/cache/describe/` | sObject schema metadata (no record data) | persistent; repo-root by default, TTL 24h |

Session GC runs at 7 days by default. To clear everything end-of-engagement:

```bash
rm -rf ~/.sandbox-seed/sessions ~/.sandbox-seed/id-maps
```

To clear only the describe cache:

```bash
rm -rf .sandbox-seeding/cache
```

Files inherit the default umask — the tool does not force `0700`. If you run on a shared workstation, set a restrictive umask (`umask 077`) before invocation.

---

## Threat model in one paragraph

The boundary protects against accidental disclosure of record data into the AI's context window during tool use. It does **not** protect against: a compromised local machine, a Salesforce user with broader-than-needed permissions, a sandbox accessed by people who shouldn't see real customer data, or a model provider with access to the on-disk session store. Standard local-data hygiene applies on both ends.
