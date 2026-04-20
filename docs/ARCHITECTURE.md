# Architecture

This doc is for contributors and auditors. If you want to use the tool, you want [MCP.md](MCP.md) or [CLI.md](CLI.md).

---

## The problem

Copying Salesforce records between orgs is not bulk-insert. Three things break a naive approach:

1. **Record IDs are per-org.** The `AccountId` on a Contact in prod is meaningless in dev. You must build a source-ID → target-ID map as you insert, and rewrite every lookup field on every subsequent insert.
2. **There are cycles.** Account ↔ Contact (via `PrimaryContactId` + `AccountId`) and many custom models. A plain topological sort doesn't terminate. You need strongly-connected-component (SCC) detection + a two-phase insert strategy for each SCC.
3. **Master-detail children cannot exist before their parents.** Ordering within the DAG matters, and the tool cannot simply "try one and retry".

`sandbox-seed` solves these three by construction.

---

## High-level flow

```
           ┌──────────────┐
user ──────▶   start      │──── validates SOQL, checks sandbox, counts scope
           └──────┬───────┘
                  │ sessionId
                  ▼
           ┌──────────────┐
           │   analyze    │──── builds DAG from root; classifies must/optional
           └──────┬───────┘
                  │
                  ▼
           ┌──────────────┐
           │   select     │──── user picks optional parents/children
           └──────┬───────┘
                  │
                  ▼
           ┌──────────────┐
           │   dry_run    │──── extract + plan + hash; no writes
           └──────┬───────┘
                  │
                  ▼
           ┌──────────────┐
           │     run      │──── 2-phase inserts + FK remap
           └──────────────┘
```

All state lives in `~/.sandbox-seed/sessions/<sessionId>/`. The tool is resumable across process restarts — the session root has everything needed to recompute state.

---

## Module layout

```
src/
├── auth/
│   └── sf-auth.ts          # delegates to `sf` CLI; reads ~/.sf/, ~/.sfdx/
├── describe/
│   ├── client.ts           # jsforce describe wrapper
│   ├── cache.ts            # on-disk describe cache (TTL-bounded)
│   └── types.ts            # narrow types over Describe SObject Result
├── graph/
│   ├── build.ts            # walk parents (upward) + children (1 level) from a root
│   ├── cycles.ts           # Tarjan's SCC, iterative — handles deep graphs
│   ├── order.ts            # topological sort of the condensation DAG
│   ├── required.ts         # required-field classification (per record-type)
│   ├── filters.ts          # field filtering (skip audit, formula, non-createable)
│   └── standard-objects.ts # stop-walking sentinels (User, Profile, etc.)
├── seed/
│   ├── session.ts          # session store (on-disk state machine)
│   ├── classify.ts         # must-include vs optional parent/child classification
│   ├── extract.ts          # SOQL → on-disk extract (never returned over MCP)
│   ├── dry-run.ts          # plan builder + hash
│   ├── id-map.ts           # source→target ID map, persisted per session
│   ├── upsert-key.ts       # external-ID / composite-key strategy per object
│   ├── execute.ts          # two-phase insert driver, FK remap, cycle handling
│   └── validation-rule-toggle.ts   # snapshot/deactivate/reactivate safety net
├── query/
│   └── counts.ts           # SELECT COUNT() only — never row data
├── render/
│   └── ...                 # tree/mermaid/dot/json for `inspect`
├── mcp/
│   ├── server.ts           # the MCP server — registers ONE tool
│   ├── main.ts             # stdio transport
│   ├── schemas.ts          # (legacy) zod schemas for removed tools
│   └── tools/
│       └── seed.ts         # the action-dispatched seed tool
└── commands/
    └── inspect.ts          # CLI command (oclif)
```

---

## How the dependency graph is built

For a root sObject (e.g. `Opportunity`):

1. Describe the root.
2. For every lookup/master-detail field on the root, walk up to the referenced object. Recurse. Stop at standard root objects (`User`, `Profile`, `Group`, …) or at `--parent-depth`.
3. For every `childRelationship` on the root (1 level deep by default), add the child as a candidate.
4. Classify each non-root node:
   - **must-include parent** — a required (non-nullable) parent reference. Must be seeded.
   - **optional parent** — nullable reference. User opts in.
   - **optional child** — user opts in.
5. Compute the SCCs of the resulting graph (Tarjan's, iterative). Any SCC with >1 node OR a self-edge is a real cycle.

See [src/graph/build.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/graph/build.ts) and [src/graph/cycles.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/graph/cycles.ts).

---

## Cycle handling: two-phase insert

For each SCC, we pick a **break edge** — ideally a nullable lookup. Then:

- **Pass 1:** Insert every node in the SCC with the break-edge field set to `null`. Populate all other lookups normally (using the source→target ID map built so far).
- **Pass 2:** For every record inserted in pass 1, patch the break-edge field with the correct target ID (now that both ends of the edge exist in the target org).

If an SCC has no nullable internal edge, the tool refuses to plan through it — this is a schema-level problem that can't be solved by insert ordering.

See [src/graph/cycles.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/graph/cycles.ts) for SCC detection and [src/seed/execute.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/seed/execute.ts) for the two-phase driver.

---

## Cross-org FK remapping

The source→target ID map is built incrementally during `run`:

1. Insert a batch of records for object `X`. The Bulk API returns new target IDs per row.
2. Write `source_id → target_id` pairs to the in-memory map and persist to disk.
3. Before inserting any subsequent object that has a lookup to `X`, rewrite that lookup field per row using the map.

The map is persisted per session so a crashed run can resume.

See [src/seed/id-map.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/seed/id-map.ts).

---

## The plan hash

`dry_run` writes a `plan.json` and computes a SHA-256 hash. The hash covers:
- Ordered list of objects to insert
- For each object: per-row schema, break-edge decisions, upsert key strategy
- Source/target aliases
- Root SOQL predicate

`run` recomputes the hash before executing. A mismatch means the session state has drifted (the user edited something, or the source org changed) and forces a new `dry_run`.

This is the "the plan you reviewed is the plan that runs" property.

See [src/seed/dry-run.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/seed/dry-run.ts).

---

## Validation-rule safety net

Seeds often fail validation rules that were written with production data in mind (required lookups to records you don't own, formula-based guards, etc.). With `disableValidationRulesOnRun: true`:

1. Before the first insert, query all `ValidationRule` records on the seeded objects where `Active=true`. Snapshot their IDs.
2. Deactivate them (bulk update `Active=false`).
3. Perform the seed.
4. Reactivate **only the ones from the snapshot** (never rules the user had pre-disabled).

If the process crashes between 2 and 4, a marker file is left in the session. The next MCP tool call refuses new work until the user runs `action: recover_validation_rules`.

Without this, a crash could silently leave a sandbox with validation rules off. We refuse to ship that failure mode.

See [src/seed/validation-rule-toggle.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/seed/validation-rule-toggle.ts).

---

## Ownership / User / Group / Queue references

References that target `User`, `Group`, or `Queue` (most commonly `OwnerId`, plus per-object fields like `AssignedToId` or `QueueId`) are deliberately **not walked** by the dependency graph builder. The reasoning:

- These objects are **org-global**, not part of a seeded business process. Copying them cross-org conflates identity and data.
- They are **frequently privileged** — a `User` row carries profile assignments, permission sets, and login state. Mirroring those into a sandbox is a security concern, not a data-seeding concern.
- There is no **stable cross-org identity** for them. `User.Username` is unique per org but almost never matches across orgs (prod `alice@acme.com` vs sandbox `alice@acme.com.fulldev`). A reliable match would require configuration the tool cannot infer.

At `run` time, FK fields pointing to these objects are serialized as `null` on insert. Salesforce then defaults them to the **target-org user performing the seed** — which is the authenticated user from the target alias. The side effects:

- `OwnerId` everywhere resolves to the seeding user. Queue-owned cases, shared folders, etc. lose their original ownership.
- `CreatedById` and `LastModifiedById` always resolve to the seeding user regardless — those fields aren't user-writable on insert.
- Per-field owner-like lookups (e.g. a custom `Assigned_Engineer__c` targeting `User`) similarly default to the seeding user.

The dry-run report surfaces a **"Defaulted owner/user/group references"** section with per-object counts so the user can see how many rows each object defaults before they run. The count comes from re-issuing the per-object scope SOQL with an `<ownerField> != null OR …` predicate — same scope, aggregated over the defaulted reference fields.

If this behavior is unacceptable for a given seed, the current workaround is:

1. Seed first with defaulting.
2. Manually build a source-user → target-user mapping (CSV or script).
3. Bulk-update ownership on the target org after the seed completes.

A first-class "User id-map" option is on the roadmap. It is deliberately not part of 0.2.0 because the right design — match by username? explicit mapping file? opt-in per field? — needs more real-world usage data.

See [src/seed/dry-run.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/seed/dry-run.ts) (`countDefaultedOwnerRefs`) and [src/graph/standard-objects.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/graph/standard-objects.ts).

---

## Test layout

| Directory | Scope |
|---|---|
| `tests/graph/` | DAG build + SCC + topological order unit tests |
| `tests/seed/` | Session state machine, classify, dry-run gate, execute, upsert-key |
| `tests/mcp/` | AI-boundary contract, seed boundary, tool-result shape |
| `tests/describe/` | Describe cache |
| `tests/render/` | Tree / mermaid / dot / json output |
| `tests/inspect/` | End-to-end CLI inspect behavior |

Run:

```bash
npm test
```

Single file:

```bash
npx vitest run tests/graph/cycles.test.ts
```

---

## Why not just fork SFDMU?

We studied it carefully (see internal research notes before clean-room cutoff). The problems:

- **Config-first, not SOQL-first.** SFDMU's `export.json` is declarative object lists with filters. Users who want to seed from a SOQL predicate have to reshape their mental model.
- **No AI-boundary concept.** SFDMU returns rows through any tool surface that wraps it.
- **MCP coupling would be a retrofit**, not a native shape. Every `sandbox-seed` tool response is structurally metadata-only by construction.

We don't depend on SFDMU or import any of its code. Different design center, different tool.
