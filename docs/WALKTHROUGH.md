# Walkthrough — four real sessions

Nothing here is staged. These are verbatim exchanges between a user and an AI host driving the `sandbox-seed` MCP, scrubbed only for org names and identifiers. Copy the user prompts into your own host and you'll get the same flow.

All four sessions assume two `sf` aliases registered with the Salesforce CLI:

- **Source:** `prod-source` — the org that holds the data you want to copy
- **Target:** `dev-target` — a developer or full-copy sandbox

Swap those placeholders for your own `sf org` aliases.

---

## Session 1 — End-to-end Case seed (the happy path)

The cleanest full run: `Case` + `Account` + `Contact` + two optional children. 306 of 308 inserts succeed; 2 fail on a target-org validation rule that had no source counterpart.

### Prompt 1 — `start`

**User**

```
action: "start"
sourceOrg: "prod-source"
targetOrg: "dev-target"
object: "Case"
whereClause: "IsClosed = false AND CreatedDate = THIS_YEAR"
sampleSize: 100
disableValidationRulesOnRun: true

USE MCP: sandbox-seed
```

**Tool response (summarized by the agent)**

| Field | Value |
|--------|--------|
| **sessionId** | `<session-id>` |
| **Source** | prod-source |
| **Target** | dev-target |
| **Root object** | Case |
| **WHERE** | `IsClosed = false AND CreatedDate = THIS_YEAR` |
| **Matches** | 162 cases |
| **Scoped** | First **100** (`ORDER BY Id`) |
| **Validation rules on run** | Will snapshot / deactivate / reactivate active rules on seeded objects |

### Prompt 2 — `analyze`

**User**

```json
{ "action": "analyze", "sessionId": "<session-id>" }
```

**Tool response**

- **Must-include parents:** none
- **Optional parents (103):** `Account`, `Asset`, `Contact`, `Lead`, `Opportunity`, `Campaign`, plus many custom objects
- **Optional children (29):** `CaseComment`, `CaseContactRole`, `EmailMessage`, `Task`, `Event`, `ContentDocumentLink`, …
- **Standard roots referenced:** `BusinessHours`, `Group`, `RecordType`, `User`
- **Cycles detected:** 6 (tool plans two-phase inserts automatically)
- **Hidden by defaults:** 70 managed-package parents, 12 managed-package children, 25 system-automation children (pass `includeManagedPackages: true` or `includeSystemChildren: true` on a new `analyze` to surface them)

### Prompt 3 — `select`

**User**

```json
{
  "action": "select",
  "sessionId": "<session-id>",
  "includeOptionalParents": ["Account", "Contact"],
  "includeOptionalChildren": ["CaseComment", "Task"]
}
```

**Tool response**

| | Objects |
|---|--------|
| **Scope** | `Case`, `Account`, `Contact`, `CaseComment`, `Task` |
| **Insert order** | `Account` → `Case` → `Contact` → `Task` → `CaseComment` |

`cycleStepCount: 1` (one two-phase cycle step handled automatically).

### Prompt 4 — `dry_run`

**User**

```json
{ "action": "dry_run", "sessionId": "<session-id>" }
```

**Tool response**

- **308 records** to insert (all INSERT; no upsert keys).
- **Per object:** Case 100, Account 100, Contact 100, CaseComment 3, Task 5.
- **1 schema warning:** a source-only custom field on `Task` will be skipped on insert.
- **37 validation rules** will be deactivated/reactivated around the insert (3 on Case, 30 on Contact, 2 on Account).
- **Report:** `~/.sandbox-seed/sessions/<session-id>/dry-run.md`

**Read the report before confirming.** It contains the exact SOQL that will run, per-object counts, and the first 100 root-scope IDs.

### Prompt 5 — `run`

**User**

```json
{ "action": "run", "sessionId": "<session-id>", "confirm": true }
```

**Tool response**

| Metric | Value |
|--------|--------|
| **Inserted (total)** | **306** / 308 planned |
| Account | 100 |
| Case | 100 |
| Contact | 98 |
| Task | 5 |
| CaseComment | 3 |
| **Errors** | **2** |
| **Validation rules** | 37 deactivated, then all reactivated |

**Failures:** both on `Contact`, `FIELD_CUSTOM_VALIDATION_EXCEPTION: "The phone selected for Preferred Phone can't be blank."` — a target-only validation rule the snapshot didn't cover. The other 306 records inserted cleanly.

Artifacts on disk:
- `~/.sandbox-seed/sessions/<session-id>/execute.log`
- `~/.sandbox-seed/sessions/<session-id>/id-map.json` (source → target Id map for future seeds)

---

## Session 2 — Clean run, 0 errors

Same orgs, different root. Demonstrates a completely clean seed of 1,271 rows with zero errors. Root is a custom object with a large child table.

### Prompt 1 — `start`

**User**

> Same source and target orgs. Root object: `Custom_Template_Item__c`. `whereClause: Id != null`

**Tool response**

| | |
|--|--|
| **sessionId** | `<session-id>` |
| **Root** | `Custom_Template_Item__c` |
| **WHERE** | `Id != null` |
| **Scoped rows** | **792** (under default `limit: 10000`; no `sampleSize`) |
| **VR on run** | `disableValidationRulesOnRun: true` |

### Prompt 2 — `analyze`

**Tool response**

- **Must-include parents:** `Custom_Template__c` (required — parent of the template items)
- **Optional parents (1):** `Account` (reachable via a cycle through the template's academic-program lookup)
- **Optional children (21):** `ActionPlan`, `Attachment`, `EmailMessage`, `Task`, `Custom_Requirement__c`, …
- **5 cycles detected**
- **Planned load order:** `Custom_Template__c` → `Custom_Template_Item__c`

### Prompt 3 — `select`

**User**

> Parent: `Custom_Template__c`
> Children: `Template_Item_Condition__c`, `Custom_Requirement__c`

**Tool response**

| Role | Objects |
|------|---------|
| Final scope | `Custom_Template_Item__c`, `Custom_Template__c`, `Template_Item_Condition__c`, `Custom_Requirement__c` |
| Load order | `Custom_Template__c` → `Custom_Template_Item__c` → `Template_Item_Condition__c` → `Custom_Requirement__c` |

### Prompt 4 — `dry_run`

- **1,271 rows planned**
- `Custom_Template_Item__c`: 792, `Custom_Template__c`: 6, `Template_Item_Condition__c`: 473, `Custom_Requirement__c`: **0** (in graph but no matching child rows)
- **0 schema warnings**
- **4 validation rules** toggled

### Prompt 5 — `run`

| | |
|--|--|
| **Errors** | **0** |
| **Total inserted** | **1,271** |
| **Validation rules** | 4 deactivated, then reactivated |

Seeding completed cleanly.

---

## Session 3 — Common mistakes + how the tool catches them

Three real errors any new user will hit.

### Mistake 1 — Passing a full `SELECT` string

**User**

```
Call sandbox_seed_seed with action: "start", sourceOrg: "prod-source",
targetOrg: "dev-target",
SELECT Id FROM Case where IsClosed = false and CreatedDate = THIS_YEAR Limit 100
```

**Agent clarification**

> `sandbox_seed_seed` does not take a full `SELECT` string. It needs the root **`object`** and a **`whereClause`** that is only the `WHERE` predicate. Your filter was mapped to **`Case`** with: `IsClosed = false AND CreatedDate = THIS_YEAR`. For **`LIMIT 100`**, the tool uses **`sampleSize: 100`** (first 100 roots by `Id`), not the `limit` field — `limit` is a safety cap on how many matches are allowed before `start` rejects.

Takeaway: `whereClause` is the predicate only. `SELECT` / `FROM` / `LIMIT` are not part of it.

### Mistake 2 — `limit` too low for the match count

**User**

```
object: "Case", whereClause: "IsClosed = false AND CreatedDate = THIS_YEAR", limit: 100
```

**Tool response**

> `UserError` — *"WHERE clause matched **162** records, exceeding limit **100**."*

Agent explanation:

> This MCP step does **not** mean "run `LIMIT 100` in SOQL"; it means **the number of rows that match the WHERE must be ≤ `limit`**. With 162 matches, `limit: 100` is rejected.

Fix: either raise `limit`, tighten the `whereClause` so ≤ 100 rows match, or use `sampleSize: 100` to deterministically pick "first 100 by `ORDER BY Id`".

### Mistake 3 — WHERE matches zero rows

**User**

```
object: "Opportunity", whereClause: "Amount > 100000 AND IsClosed = false"
```

**Tool response**

> `UserError`: *"WHERE clause matched 0 records on Opportunity."*

The tool refuses to create a session when nothing matches. Test your predicate in Workbench or `sf data query` first, or relax the filter.

---

## Session 4 — Asking the agent about the tool before using it

If you want the agent to describe the tool before calling it, ask directly:

**User**

> can you read the sandbox-seed MCP

**Agent response** (excerpt)

> ### `sandbox_seed_seed`
>
> **Purpose:** Copy / migrate / seed real Salesforce records between orgs (e.g. prod → sandbox), with dependency handling, ID remapping, dry-run, and disk-backed data so the model mostly sees **counts and file paths**, not full record payloads.
>
> **Five-step flow** (same tool, different `action`):
> 1. **`start`** — `sourceOrg`, `targetOrg`, `object`, `whereClause` (required). Returns a `sessionId` to reuse.
> 2. **`analyze`** — Must-include vs optional parents/children.
> 3. **`select`** — Optional `includeOptionalParents` / `includeOptionalChildren` arrays.
> 4. **`dry_run`** — Mandatory before run; writes counts/schema diff to disk.
> 5. **`run`** — Requires `confirm: true` and user approval after dry-run.
>
> **Important rules:**
> - `whereClause` must be real SOQL the user supplied. If the user only says "top 3" or "recent" in prose, the agent should stop and ask for an explicit WHERE clause.
> - Target org must be a sandbox; production targets are refused.
> - If `whereClause` matches more than `limit`, `start` rejects unless you use `sampleSize` for "first N by `ORDER BY Id`".

---

## Follow-up pattern — let the agent help you write the SOQL

The tool refuses to invent `whereClause` from phrases like "biggest" or "recent". The correct flow is to ask the agent to *help you write* the SOQL first, then paste it back into `start`.

**User**

> I want 100 contacts who have an active application where application status = submitted or on hold

**Agent**

> In your repo, applications are the `Application__c` custom object, linked to the person via `Applicant__c` → `Contact`, and status is `Application_Status__c`. …
>
> ```sql
> SELECT Id, Name
> FROM Contact
> WHERE Id IN (
>   SELECT Applicant__c
>   FROM Application__c
>   WHERE Application_Status__c IN ('Submitted', 'On Hold')
> )
> ORDER BY LastModifiedDate DESC
> LIMIT 100
> ```

Then in your `start` call, the `whereClause` is **only the predicate**:

```
Id IN (SELECT Applicant__c FROM Application__c
       WHERE Application_Status__c IN ('Submitted', 'On Hold'))
```

Semi-joins in `whereClause` are supported as of 0.2.0.
