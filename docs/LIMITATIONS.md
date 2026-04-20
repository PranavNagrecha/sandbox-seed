# Known limitations

A single page listing everything `sandbox-seed` **doesn't** do today, organized by category. If a limitation below is blocking your use case, open an issue — several of these are on the roadmap but haven't been prioritized without a concrete ask.

For the overall scope of the 0.2.x line and the AI-boundary contract, see the [README](../README.md) and [AI_BOUNDARY.md](AI_BOUNDARY.md). This page is the exhaustive detail.

---

## Ownership and user/group references

**User / Group / Queue FKs default to the running user.** References like `OwnerId`, `AssignedToId`, `QueueId`, and any field whose `referenceTo` includes `User`, `Group`, or `Queue` are not walked into the dependency graph. At run time these fields are omitted on insert, which means Salesforce fills them from the profile of the integration user performing the seed.

**No owner remapping.** There is no mechanism today to map source-org user IDs to target-org user IDs. If you need specific ownership in the target, set it after seeding or pre-populate the id-map with explicit `User:<sourceId>=<targetId>` entries before running.

**The dry-run report counts this.** "Defaulted owner/user/group references" per object in the dry-run output tells you how many rows will have this rewrite applied so you can decide whether to proceed.

---

## Cross-run state

**Project id-map is per-(source, target) pair.** The persistent map at `~/.sandbox-seed/id-maps/<sourceAlias>__<targetAlias>.json` is keyed by the exact sf alias pair. Changing aliases on either side starts a fresh map. There is no team-shared map or central registry.

**The project id-map is trusted, not verified.** If a target row is deleted out-of-band (manual cleanup, another data loader, a sandbox refresh the tool didn't observe), the map still points at the dead target id and the next run's insert fails with `INVALID_CROSS_REFERENCE_KEY`. `execute.log` flags the specific stale entries and suggests recovery via `isolateIdMap: true`. See [AI_BOUNDARY.md](AI_BOUNDARY.md#what-this-is-not).

**One session = one id-map for that session's records.** Within a session, the per-session id-map is populated in dependency order; across sessions, the project map stitches FKs back together. If you seed Accounts in session A and Contacts (which reference those Accounts) in session B, the project map resolves the FK. The only composition limit is when `isolateIdMap: true` is set.

---

## Schema coverage

**Source-only fields are silently dropped.** Any field present on the source object but not the target object is excluded from the insert body. The dry-run report lists dropped field names per object; execute.log repeats the count. No rename, no manual override — if the target schema is missing a field, that column is not copied.

**No field transforms.** There is no hook to rewrite, mask, or compute values mid-flow. Source value in, identical value out (except for FK id rewrites).

**Record types are matched by `DeveloperName`.** When both source and target have record types on an object, the tool matches them by `DeveloperName` and pre-populates the id-map. If the DeveloperNames don't match across orgs, the field is omitted on insert and Salesforce's default-picker fills from the running user. There is no fallback match by label or by ID.

**ContentDocument / Attachment binary payloads are not supported.** The tool operates on SOQL-queryable records only. Binary file bodies require the Files/ContentVersion multipart upload APIs which this version does not implement.

**Person accounts are not supported.** The dual-record (Account + Contact) semantics of person accounts aren't modeled. Standard Account + Contact works; person accounts may behave unpredictably.

---

## Auth

**Encrypted sfdx tokens require the `sf` CLI.** The project reads `~/.sf/` auth files; if the target tokens are encrypted, `sf` must be on `PATH` to decrypt them. The OAuth device flow is the only alternative — there is no JWT bearer flow.

**No multi-user auth isolation.** The tool uses whichever auth is active for the sf alias. If multiple users share a workstation and the alias points at a different user's token, the seed runs as that user.

See [AUTH.md](AUTH.md) for setup details.

---

## Performance

**Describes are sequential.** The describe cache is TTL-bounded (24h default) and per-object, but cold-cache walks against a managed-package-heavy org issue one describe per object in sequence. Full-graph analyze against a complex Case or Opportunity hierarchy can take 30–90 seconds on first run.

**Extract queries are per-object, not parallelized.** The extract phase walks the dependency graph in a determined order and issues one or more SOQL queries per object. Large root sets with deep hierarchies generate many round-trips.

**No bulk API.** All writes go through the composite REST endpoint (200 rows per batch). Beyond ~10k records per object, Bulk API v2 would be faster — that's on the roadmap.

---

## AI boundary

**The boundary applies to the MCP tool envelope, not to the files on disk.** The dry-run report, extract files, id-maps, and execute log all contain record IDs and full SOQL on disk. Any LLM with file-read access to your workstation can read them. The boundary guarantee is about the tool-call response shape, not about local filesystem access.

**The boundary does not protect against a compromised local machine.** If an attacker can read `~/.sandbox-seed/sessions/`, they have the data. Standard local-data hygiene applies.

**The boundary does not enforce least-privilege on the source org.** If your Salesforce user can see the data, the tool can extract it. Use a scoped integration user — no permission layering happens inside the tool.

See [AI_BOUNDARY.md](AI_BOUNDARY.md) for the full contract.

---

## Graph walk

**Child-lookup expansion is one hop only.** When you name a reference field on a direct child of the root, the walker follows it exactly one hop further. No transitive expansion, no auto-discovery. For a two-hop chain, root the seed at the deepest object so its parents are walked transitively.

**No auto-discovery of multi-path objects.** If an object is reachable via both a direct FK and a child-lookup, scopes are unioned and dedup'd by Id, but the tool does not automatically discover that shape — you must name the child-lookup reference.

---

## What's on the roadmap, not shipped

- Synthetic data generation
- PII masking / field-level transforms
- CSV import as an alternative to live SOQL
- Multi-target fan-out (seed one source into N sandboxes in one flow)
- Bulk API v2 for large volumes
- Explicit user/owner remapping
- First-class CLI `seed` command (today only `inspect` is CLI-available)
