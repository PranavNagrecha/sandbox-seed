# Product Requirements — Salesforce Sandbox Seeding CLI

## Core requirements (from user, 2026-04-19)

### Two operating modes
The tool has exactly two modes of operation. A run is one or the other — not mixed.

- **SF → SF mode:** pull data from a source org, optionally scramble, load into a target org.
- **Fake → SF mode:** generate synthetic data from a recipe, load into a target org.

### Requirements
1. **SOQL-driven data selection (SF → SF mode)** — user supplies SOQL queries to define what data to seed. The tool walks relationships outward from the result set.
2. **Parent-child relationship handling** — first-class and correct in both modes. Lookups, master-detail, junction objects, self-referential, and circular references all resolved automatically. Non-negotiable.
3. **Fake data generation (Fake → SF mode)** — generate synthetic records. Referentially consistent, schema-aware.
4. **Simple data scrambling / masking (SF → SF mode)** — anonymize PII in flight between source and target. Usable without heavy config.
5. **Fully local execution** — runs on the user's machine only. No servers, no cloud components, no telemetry.
6. **AI usage policy** — tool runs inside Claude Code and the dev experience leans on AI (recipe authoring, debugging, describe-call interpretation). **No org data is ever sent to any AI provider.** AI touches recipes, schemas, and tool output only — never record payloads.

### Build posture
- **Clean-room implementation.** We study SFDMU to learn the problem space; we do not copy its code. No dependency on SFDMU packages.
- Match their `export.json` *concept* where it's well-designed, but ship our own format.

### Locked design decisions (2026-04-19)
- **Recipe format:** YAML with JSON Schema validation + a minimal expression syntax for refs and generators (e.g., `${Account.Id}`, `${{ fake.email }}`). Rationale: human-readable, comment-friendly, IDE autocomplete via schema, AI-edit-friendly, aligns with Snowfakery/CumulusCI convention.
- **Distribution:** Standalone CLI binary. Not an `sf` plugin. Own commands, own help, own versioning.
- **Authentication:** Read `~/.sf/` auth files if present (zero-config for users of the `sf` CLI). Fall back to our own OAuth device flow for users without `sf` installed. No hard dependency on `sf` being installed.
- **Sources supported in v1:** SF org (via SOQL) and synthetic generation. CSV-in is deferred — not in v1.

## Implications for design

### SOQL-first input model
- Input is a SOQL query (or set of queries), not an object-list with filters
- Tool executes the query, then computes the closure: required parents, required children (opt-in), lookups
- Recipe file anchors queries and adds per-object overrides (mapping, masking, generation)

### Relationship resolution
- Build real DAG over objects in the closure; Tarjan's SCC for cycles
- Cycle strategy: two-phase insert (nullable FK first, back-fill after) for every SCC, not just self-references
- ID remapping via external-ID or in-memory `@ref` map

### Mode-specific behavior
- **SF → SF:** field-level options are `copy` or `scramble` (per-field). Scramblers: deterministic hash-based (same input → same masked output across runs), plus presets for email, phone, name, address.
- **Fake → SF:** field-level options are `generate` strategies (faker presets, literal, sequence, reference to another generated record).
- Shared across both modes: the relationship-resolution engine, describe-metadata loader, Bulk API loader.

### Local-only architecture
- No daemon, no cloud, no shared state
- All describe metadata cached to `.sandbox-seeding/cache/` on disk
- Bulk API v2 calls go org-to-local-disk-to-org; no intermediate services
- Works offline except for the org API calls themselves

### AI boundary (strict)
- **In-bounds for AI:** recipe authoring, SOQL suggestion from natural language, describe-metadata explanation, error-message interpretation, dependency-graph visualization, test generation
- **Out-of-bounds for AI:** actual record data, query results, CSV contents, Bulk API payloads
- Enforcement: AI-assisted code paths operate on schemas and recipes only; data paths have no AI hook points
- Document this boundary prominently (README, `--help`, security doc)

## Non-requirements (explicitly out of scope for v1)
- Users, Profiles, Permission Sets seeding
- Big Objects, External Objects
- Metadata deployment (that's `sf project deploy`, not us)
- GUI / desktop app (CLI only)
- Cloud / hosted mode
