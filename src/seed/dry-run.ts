import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrgAuth } from "../auth/sf-auth.ts";
import type { DescribeClient } from "../describe/client.ts";
import type { Field, SObjectDescribe } from "../describe/types.ts";
import { isReference } from "../describe/types.ts";
import { UserError } from "../errors.ts";
import type { DependencyGraph } from "../graph/build.ts";
import type { LoadPlan } from "../graph/order.ts";
import { salesforceFetch } from "../salesforce-fetch.ts";
import {
  ROOT_ID_CHUNK,
  type ScopePath,
  chunkIds,
  computeScopePaths,
  queryIds,
  soqlIdList,
} from "./extract.ts";
import { buildCanonicalPlan, canonicalStringify, hashCanonicalPlan } from "./plan-hash.ts";
import { ProjectIdMap, type TargetIdentity } from "./project-id-map.ts";
import type { DryRunSummary, UpsertDecisionSummary } from "./session.ts";
import { discoverCandidates, queryFieldPopulation, resolveUpsertKey } from "./upsert-key.ts";

const DEFAULTED_OWNER_TARGETS = new Set(["User", "Group", "Queue"]);

/**
 * Dry-run: for each object in the final load order, determine how many
 * source records are in scope and whether the target org can accept them.
 *
 * Produces:
 *   - Summary (returned to caller, LLM-safe) — counts, issue names, paths.
 *   - Report file on disk (for user consumption) — counts, scope SOQL, and
 *     schema-diff details. May contain record IDs of the root scope; stays
 *     local to `~/.sandbox-seed/sessions/<id>/dry-run.md`.
 *
 * Mandatory before `run`: the session stores `dryRun.completedAt` and
 * `run` refuses unless it's within 24h.
 */
export type DryRunOptions = {
  sourceAuth: OrgAuth;
  targetAuth: OrgAuth;
  sourceDescribe: DescribeClient;
  targetDescribe: DescribeClient;
  graph: DependencyGraph;
  rootObject: string;
  whereClause: string;
  finalObjectList: string[];
  /**
   * Restricted load order — same object the run will execute against.
   * Required: the plan hash is computed over this shape, so the caller
   * MUST pass the same load plan it will feed to `runExecute` (otherwise
   * the run-time hash check fires a false positive).
   */
  loadPlan: LoadPlan;
  sessionDir: string;
  fetchFn?: typeof fetch;
  /** See src/seed/extract.ts ScopePath kind="child-lookup". */
  childLookups?: Record<string, string[]>;
  /**
   * When provided (and `isolateIdMap` is not set), dry-run consults the
   * persistent project-level id-map so "already seeded on prior run"
   * counts appear in the summary. Pure read-only — the map is never
   * written from dry-run.
   */
  sourceAlias?: string;
  /** See `sourceAlias`. */
  targetAliasForIdMap?: string;
  targetIdentity?: TargetIdentity;
  isolateIdMap?: boolean;
  /**
   * Per-object upsert-key overrides set at session start. When present,
   * resolveUpsertKey uses the named field verbatim instead of running
   * auto-pick by population — provided the field is still in the
   * source's candidate set. Invalid overrides surface as
   * `ambiguous: "override-invalid"` so the user sees the typo or stale
   * field name and can fix it before `run`.
   */
  upsertKeyOverrides?: Record<string, string>;
  /**
   * Pre-materialized root scope when `sampleSize` was applied at start.
   * See `ExecuteOptions.sampledRootIds`. dry_run honors this so the
   * scope it reports MATCHES what the run will process.
   */
  sampledRootIds?: string[];
};

export async function runDryRun(opts: DryRunOptions): Promise<DryRunSummary> {
  const allPaths = computeScopePaths(
    opts.graph,
    opts.rootObject,
    opts.finalObjectList,
    opts.childLookups,
  );
  // Group paths by object — an object may be reachable via multiple paths
  // (e.g. direct-parent AND child-lookup). Counts union the ID sets.
  const pathsByObject = new Map<string, ScopePath[]>();
  for (const p of allPaths) {
    const list = pathsByObject.get(p.object) ?? [];
    list.push(p);
    pathsByObject.set(p.object, list);
  }

  // Materialize root scope IDs — we need them to resolve transitive parents,
  // and we write a sample into the report for the user. When the session
  // was started with `sampleSize`, the sampled IDs are already on the
  // session; reuse them so the dry-run scope MATCHES what the run will
  // process (and avoid re-querying the WHERE clause from scratch).
  const rootIds =
    opts.sampledRootIds !== undefined && opts.sampledRootIds.length > 0
      ? [...opts.sampledRootIds]
      : await queryIds({
          auth: opts.sourceAuth,
          soql: `SELECT Id FROM ${opts.rootObject} WHERE ${opts.whereClause}`,
          fetchFn: opts.fetchFn,
        });

  if (rootIds.length === 0) {
    throw new UserError(
      `WHERE clause returned 0 records on ${opts.rootObject} — nothing to seed.`,
      `Adjust the WHERE clause and call seed with action: "start" again.`,
    );
  }

  const perObjectCounts: Record<string, number> = {};
  const perObjectSoql: Record<string, string> = {};
  const perObjectKind: Record<string, string> = {};
  const materializedIds = new Map<string, string[]>();
  materializedIds.set(opts.rootObject, rootIds);

  // Optional: load the persistent project-level map so the dry-run can
  // predict how many in-scope source rows the run will skip as
  // already-seeded. Read-only — never written from dry-run.
  let projectEntries: Record<string, string> = {};
  let projectIdMapPath: string | undefined;
  let projectIdMapInvalidated: DryRunSummary["projectIdMapInvalidated"];
  if (
    opts.isolateIdMap !== true &&
    typeof opts.sourceAlias === "string" &&
    opts.sourceAlias.length > 0 &&
    opts.targetIdentity !== undefined
  ) {
    const targetAlias = opts.targetAliasForIdMap;
    if (typeof targetAlias === "string" && targetAlias.length > 0) {
      const pm = new ProjectIdMap({
        sourceAlias: opts.sourceAlias,
        targetAlias,
      });
      projectIdMapPath = pm.paths().mapPath;
      // Dry-run treats invalidation as a non-destructive observation.
      // We still archive (matching `load()` semantics) and surface the
      // reason; the resulting empty map means zero predicted skips.
      const loaded = await pm.load(opts.targetIdentity);
      projectEntries = loaded.entries;
      if (loaded.invalidated !== null) {
        projectIdMapInvalidated = loaded.invalidated;
      }
    }
  }

  const alreadySeededCounts: Record<string, number> = {};
  const haveProjectMap = Object.keys(projectEntries).length > 0;
  for (const [object, paths] of pathsByObject) {
    const unionedIds = new Set<string>();
    const soqlPieces: string[] = [];
    const kinds: string[] = [];
    for (const path of paths) {
      const res = await idsForPath({
        auth: opts.sourceAuth,
        rootObject: opts.rootObject,
        whereClause: opts.whereClause,
        rootIds,
        path,
        materializedIds,
        fetchFn: opts.fetchFn,
      });
      for (const id of res.ids) unionedIds.add(id);
      soqlPieces.push(`-- path kind=${path.kind}\n${res.soql}`);
      kinds.push(path.kind);
    }
    perObjectCounts[object] = unionedIds.size;
    perObjectSoql[object] = soqlPieces.join("\n\n");
    perObjectKind[object] = kinds.join("+");
    // Make the union IDs available to transitive chains that might depend
    // on this object later (rare but possible).
    if (unionedIds.size > 0) {
      materializedIds.set(object, [...unionedIds]);
    }
    if (haveProjectMap && unionedIds.size > 0) {
      let hits = 0;
      for (const srcId of unionedIds) {
        if (projectEntries[`${object}:${srcId}`] !== undefined) hits++;
      }
      if (hits > 0) alreadySeededCounts[object] = hits;
    }
  }

  // Schema diff against target. Flag any missing object or createable
  // field that the source has but the target lacks. In the same pass,
  // compute the INSERT-vs-UPSERT decision — it needs the same pair of
  // describes, so one pass avoids re-fetching them in `run`.
  const schemaIssues: string[] = [];
  const upsertDecisions: Record<string, UpsertDecisionSummary> = {};
  for (const object of opts.finalObjectList) {
    try {
      const srcDesc = await opts.sourceDescribe.describeObject(object);
      let tgtDesc = null;
      try {
        tgtDesc = await opts.targetDescribe.describeObject(object);
      } catch {
        schemaIssues.push(`${object}: object missing in target org`);
        // Fall through to still record an ambiguous upsert decision
        // (target-describe-failed) so `run` logs the reason it chose
        // INSERT rather than silently defaulting.
      }
      if (tgtDesc !== null) {
        const tgtFields = new Set(tgtDesc.fields.map((f) => f.name));
        const missing: string[] = [];
        for (const f of srcDesc.fields) {
          if (f.createable === false) continue;
          if (f.defaultedOnCreate === true) continue;
          if (f.calculated === true) continue;
          if (!tgtFields.has(f.name)) missing.push(f.name);
        }
        if (missing.length > 0) {
          schemaIssues.push(
            `${object}: ${missing.length} source-only field(s) will be skipped during run: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`,
          );
        }
      }
      // Population probe — only needed when the source has 2+ ext-id
      // candidates, since the single-candidate path doesn't need to
      // disambiguate. One extra SOQL per ambiguous object; ~free for
      // dry-run. Scope: pass the user's WHERE clause only for the root
      // (it's the only object whose scope is expressible as a literal
      // WHERE); for child / parent objects we count against the whole
      // object — a small approximation in exchange for not having to
      // materialize per-object scope.
      const candidateNames = discoverCandidates(srcDesc).map((c) => c.name);
      let populationByField: Map<string, number> | undefined;
      if (candidateNames.length > 1) {
        try {
          populationByField = await queryFieldPopulation({
            auth: opts.sourceAuth,
            object,
            fields: candidateNames,
            whereClause: object === opts.rootObject ? opts.whereClause : undefined,
            fetchFn: opts.fetchFn,
          });
        } catch {
          // Best-effort — if the probe fails, fall back to the
          // historic "multiple-candidates" ambiguous result.
        }
      }
      const override = opts.upsertKeyOverrides?.[object];
      upsertDecisions[object] = resolveUpsertKey(srcDesc, tgtDesc, {
        populationByField,
        override,
      });
    } catch (err) {
      schemaIssues.push(
        `${object}: describe failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // Estimate User/Group/Queue FKs that will be defaulted at run time.
  // These standard-roots are NOT remapped (only RecordType is); any row
  // with a populated reference gets its field omitted during rewrite so
  // Salesforce's default (running user) takes over. Count here so the
  // user sees the impact before running.
  const defaultedByObject = await countDefaultedOwnerRefs({
    objects: opts.finalObjectList,
    sourceAuth: opts.sourceAuth,
    sourceDescribe: opts.sourceDescribe,
    perObjectSoql,
    fetchFn: opts.fetchFn,
  });
  const totalDefaultedOwnerRefs = Object.values(defaultedByObject).reduce((a, b) => a + b, 0);

  const totalRecords = Object.values(perObjectCounts).reduce((a, b) => a + b, 0);
  const completedAt = new Date().toISOString();
  const reportPath = join(opts.sessionDir, "dry-run.md");

  const sourceAliasForHash = opts.sourceAuth.alias ?? opts.sourceAuth.username;
  const targetAliasForHash = opts.targetAuth.alias ?? opts.targetAuth.username;

  // Canonical plan + hash. Written to disk as plan.json; hex digest stored
  // on the session so `run` can recompute and refuse on drift.
  const canonicalPlan = buildCanonicalPlan({
    rootObject: opts.rootObject,
    whereClause: opts.whereClause,
    sourceAlias: sourceAliasForHash,
    targetAlias: targetAliasForHash,
    finalObjectList: opts.finalObjectList,
    loadPlan: opts.loadPlan,
    upsertDecisions,
    sampledRootIds: opts.sampledRootIds,
  });
  const planHash = hashCanonicalPlan(canonicalPlan);
  const planPath = join(opts.sessionDir, "plan.json");
  await writeFile(planPath, canonicalStringify(canonicalPlan), "utf8");

  await writeFile(
    reportPath,
    renderReport({
      rootObject: opts.rootObject,
      whereClause: opts.whereClause,
      rootIds,
      finalObjectList: opts.finalObjectList,
      perObjectCounts,
      perObjectSoql,
      perObjectKind,
      schemaIssues,
      upsertDecisions,
      completedAt,
      sourceAlias: sourceAliasForHash,
      targetAlias: targetAliasForHash,
      planHash,
      defaultedOwnerRefByObject: defaultedByObject,
      totalDefaultedOwnerRefs,
    }),
    "utf8",
  );

  return {
    reportPath,
    perObjectCounts,
    totalRecords,
    completedAt,
    targetSchemaIssues: schemaIssues,
    upsertDecisions,
    alreadySeededCounts:
      Object.keys(alreadySeededCounts).length > 0 ? alreadySeededCounts : undefined,
    projectIdMapPath,
    projectIdMapInvalidated,
    planHash,
    planPath,
    defaultedOwnerRefCount: totalDefaultedOwnerRefs,
    defaultedOwnerRefByObject:
      Object.keys(defaultedByObject).length > 0 ? defaultedByObject : undefined,
  };
}

/**
 * For each object, query the source for rows where any User/Group/Queue
 * reference field is populated. Those references will NOT be remapped at
 * run time (only RecordType is remapped), so the run silently defaults
 * them to the running user. This preview lets users see the blast radius
 * before executing.
 *
 * Best-effort: skips objects whose describe or count query fails, and
 * returns a partial map. A missing entry means "couldn't measure", not
 * "no references."
 */
async function countDefaultedOwnerRefs(args: {
  objects: string[];
  sourceAuth: OrgAuth;
  sourceDescribe: DescribeClient;
  perObjectSoql: Record<string, string>;
  fetchFn?: typeof fetch;
}): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const object of args.objects) {
    let desc: SObjectDescribe;
    try {
      desc = await args.sourceDescribe.describeObject(object);
    } catch {
      continue;
    }
    const ownerFields: Field[] = [];
    for (const f of desc.fields) {
      if (!isReference(f)) continue;
      if (f.createable === false) continue;
      const targets = f.referenceTo;
      if (targets.some((t) => DEFAULTED_OWNER_TARGETS.has(t))) {
        ownerFields.push(f);
      }
    }
    if (ownerFields.length === 0) continue;

    // Reuse the first per-object scope SOQL line to pin the same WHERE as
    // dry-run's count, then add the owner-FK populated filter. Skip the
    // object if the stored SOQL is a comment (transitive/unknown path) or
    // doesn't have a WHERE to extend.
    const scopeSoql = args.perObjectSoql[object];
    if (scopeSoql === undefined || scopeSoql.length === 0) continue;
    const firstPath = scopeSoql.split("\n\n")[0] ?? "";
    const soqlLine = firstPath.split("\n").find((l) => l.toUpperCase().startsWith("SELECT"));
    if (soqlLine === undefined) continue;
    const whereIx = soqlLine.toUpperCase().indexOf(" WHERE ");
    if (whereIx === -1) continue;
    const whereBody = soqlLine.slice(whereIx + 7);
    const filters = ownerFields.map((f) => `${f.name} != null`).join(" OR ");
    const countSoql = `SELECT COUNT() FROM ${object} WHERE (${whereBody}) AND (${filters})`;
    try {
      const n = await countQuery({
        auth: args.sourceAuth,
        soql: countSoql,
        fetchFn: args.fetchFn,
      });
      if (n > 0) out[object] = n;
    } catch {
      // Best-effort preview — never fails the dry-run.
    }
  }
  return out;
}

async function countQuery(opts: {
  auth: OrgAuth;
  soql: string;
  fetchFn?: typeof fetch;
}): Promise<number> {
  const url = `${opts.auth.instanceUrl}/services/data/v${opts.auth.apiVersion}/query?q=${encodeURIComponent(opts.soql)}`;
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await salesforceFetch(fetchFn, url, {
    headers: {
      Authorization: `Bearer ${opts.auth.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`count query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { totalSize?: number };
  return typeof body.totalSize === "number" ? body.totalSize : 0;
}

async function idsForPath(opts: {
  auth: OrgAuth;
  rootObject: string;
  whereClause: string;
  rootIds: string[];
  path: ScopePath;
  materializedIds: Map<string, string[]>;
  fetchFn?: typeof fetch;
}): Promise<{ ids: string[]; soql: string }> {
  const { path } = opts;

  if (path.kind === "root") {
    const soql = `SELECT Id FROM ${path.object} WHERE ${opts.whereClause}`;
    return { ids: opts.rootIds, soql };
  }

  if (path.kind === "direct-parent" && path.rootFk !== undefined) {
    if (opts.rootIds.length === 0) {
      return {
        ids: [],
        soql: `-- direct-parent ${path.object} via ${path.rootFk}: root scope is empty`,
      };
    }
    return await runChunkedIdQuery({
      auth: opts.auth,
      rootIds: opts.rootIds,
      fetchFn: opts.fetchFn,
      composeSoql: (idList) =>
        `SELECT Id FROM ${path.object} ` +
        `WHERE Id IN (SELECT ${path.rootFk} FROM ${opts.rootObject} WHERE Id IN (${idList}))`,
    });
  }

  if (path.kind === "direct-child" && path.childFk !== undefined) {
    if (opts.rootIds.length === 0) {
      return {
        ids: [],
        soql: `-- direct-child ${path.object} via ${path.childFk}: root scope is empty`,
      };
    }
    return await runChunkedIdQuery({
      auth: opts.auth,
      rootIds: opts.rootIds,
      fetchFn: opts.fetchFn,
      composeSoql: (idList) => `SELECT Id FROM ${path.object} WHERE ${path.childFk} IN (${idList})`,
    });
  }

  if (
    path.kind === "child-lookup" &&
    path.childObject !== undefined &&
    path.lookupField !== undefined &&
    path.childFkToRoot !== undefined
  ) {
    if (opts.rootIds.length === 0) {
      return {
        ids: [],
        soql: `-- child-lookup ${path.object} via ${path.childObject}.${path.lookupField}: root scope is empty`,
      };
    }
    return await runChunkedIdQuery({
      auth: opts.auth,
      rootIds: opts.rootIds,
      fetchFn: opts.fetchFn,
      composeSoql: (idList) =>
        `SELECT Id FROM ${path.object} ` +
        `WHERE Id IN (SELECT ${path.lookupField} FROM ${path.childObject} ` +
        `WHERE ${path.childFkToRoot} IN (${idList}))`,
    });
  }

  if (path.kind === "transitive" && Array.isArray(path.chain) && path.chain.length >= 3) {
    const soql = `-- transitive chain ${path.chain.join(" → ")} not yet supported for count`;
    return { ids: [], soql };
  }

  return {
    ids: [],
    soql: `-- no known path from ${opts.rootObject} to ${path.object}; skipped`,
  };
}

/**
 * Run a chunked `SELECT Id ...` query: split rootIds into URL-safe chunks,
 * issue one query per chunk, union the resulting IDs.
 *
 * `composeSoql(idList)` receives an already-quoted comma-separated string
 * of IDs for one chunk; it returns the full SOQL for that chunk. The first
 * chunk's SOQL is returned verbatim for the dry-run report, prefixed with
 * a `-- chunked: ...` comment when more than one chunk was issued so the
 * user can see that the query is split.
 */
async function runChunkedIdQuery(opts: {
  auth: OrgAuth;
  rootIds: string[];
  composeSoql: (idList: string) => string;
  fetchFn?: typeof fetch;
}): Promise<{ ids: string[]; soql: string }> {
  const chunks = chunkIds(opts.rootIds, ROOT_ID_CHUNK);
  const unioned = new Set<string>();
  let firstSoql = "";
  for (const chunk of chunks) {
    const idList = soqlIdList(chunk);
    const soql = opts.composeSoql(idList);
    if (firstSoql === "") firstSoql = soql;
    const got = await queryIds({ auth: opts.auth, soql, fetchFn: opts.fetchFn });
    for (const id of got) unioned.add(id);
  }
  const annotatedSoql =
    chunks.length > 1
      ? `-- chunked into ${chunks.length} queries of up to ${ROOT_ID_CHUNK} root IDs each; first chunk shown\n${firstSoql}`
      : firstSoql;
  return { ids: [...unioned], soql: annotatedSoql };
}

function renderReport(args: {
  rootObject: string;
  whereClause: string;
  rootIds: string[];
  finalObjectList: string[];
  perObjectCounts: Record<string, number>;
  perObjectSoql: Record<string, string>;
  perObjectKind: Record<string, string>;
  schemaIssues: string[];
  upsertDecisions: Record<string, UpsertDecisionSummary>;
  completedAt: string;
  sourceAlias: string;
  targetAlias: string;
  planHash: string;
  defaultedOwnerRefByObject: Record<string, number>;
  totalDefaultedOwnerRefs: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Sandbox-seed dry run`);
  lines.push(``);
  lines.push(`Generated: ${args.completedAt}`);
  lines.push(`Source org: \`${args.sourceAlias}\``);
  lines.push(`Target org: \`${args.targetAlias}\``);
  lines.push(`Root object: \`${args.rootObject}\``);
  lines.push(`WHERE clause: \`${args.whereClause}\``);
  lines.push(``);
  lines.push(`## Scope summary`);
  lines.push(``);
  lines.push(`| Object | Kind | Count |`);
  lines.push(`| --- | --- | --- |`);
  for (const obj of args.finalObjectList) {
    const count = args.perObjectCounts[obj] ?? 0;
    const kind = args.perObjectKind[obj] ?? "?";
    lines.push(`| \`${obj}\` | ${kind} | ${count} |`);
  }
  const total = Object.values(args.perObjectCounts).reduce((a, b) => a + b, 0);
  lines.push(``);
  lines.push(`**Total records in scope: ${total}**`);
  lines.push(``);

  lines.push(`## SOQL per object`);
  lines.push(``);
  for (const obj of args.finalObjectList) {
    lines.push(`### ${obj}`);
    lines.push(``);
    lines.push(`\`\`\`sql`);
    lines.push(args.perObjectSoql[obj] ?? "");
    lines.push(`\`\`\``);
    lines.push(``);
  }

  lines.push(`## Root scope IDs (first 100)`);
  lines.push(``);
  lines.push(`\`\`\``);
  for (const id of args.rootIds.slice(0, 100)) {
    lines.push(id);
  }
  if (args.rootIds.length > 100) {
    lines.push(`… and ${args.rootIds.length - 100} more`);
  }
  lines.push(`\`\`\``);
  lines.push(``);

  lines.push(`## Write strategy per object (INSERT vs UPSERT)`);
  lines.push(``);
  lines.push(
    `Objects with a single unambiguous external-id field will be written ` +
      `with composite UPSERT — re-runs against a non-empty target update ` +
      `existing rows instead of failing with DUPLICATE_VALUE. Anything else ` +
      `falls back to composite INSERT (same behavior as prior versions).`,
  );
  lines.push(``);
  lines.push(`| Object | Strategy | Key field / reason |`);
  lines.push(`| --- | --- | --- |`);
  for (const obj of args.finalObjectList) {
    const d = args.upsertDecisions[obj];
    if (d === undefined) {
      lines.push(`| \`${obj}\` | INSERT | describe unavailable (see schema section) |`);
      continue;
    }
    if (d.kind === "picked") {
      lines.push(`| \`${obj}\` | UPSERT | \`${d.field}\` |`);
    } else {
      lines.push(`| \`${obj}\` | INSERT | ${d.reason}: ${d.detail} |`);
    }
  }
  lines.push(``);

  lines.push(`## Target schema validation`);
  lines.push(``);
  if (args.schemaIssues.length === 0) {
    lines.push(`No schema mismatches detected. Target has every createable field the source has.`);
  } else {
    lines.push(
      `The following source-only fields will be **auto-skipped** during \`run\` ` +
        `(the records insert successfully; those specific field values are not carried over):`,
    );
    lines.push(``);
    for (const issue of args.schemaIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push(``);
    lines.push(
      `If you need any of these fields carried over, deploy them to the target org ` +
        `before running. Otherwise, the run proceeds with them dropped.`,
    );
  }
  lines.push(``);
  lines.push(`## User / Group / Queue references (will be defaulted)`);
  lines.push(``);
  if (args.totalDefaultedOwnerRefs === 0) {
    lines.push(
      `No in-scope records reference User, Group, or Queue objects. Ownership ` +
        `will match whatever Salesforce assigns by default on insert.`,
    );
  } else {
    lines.push(
      `Sandbox-seed does **not** remap User / Group / Queue references across orgs. ` +
        `Any row with a populated \`OwnerId\`, \`CreatedById\`, or similar User / Group / ` +
        `Queue lookup will be inserted with the field omitted — Salesforce applies the ` +
        `running user's default. If preserving ownership matters, this version doesn't ` +
        `give it to you.`,
    );
    lines.push(``);
    lines.push(`| Object | Rows with User/Group/Queue refs populated |`);
    lines.push(`| --- | --- |`);
    for (const obj of args.finalObjectList) {
      const n = args.defaultedOwnerRefByObject[obj] ?? 0;
      if (n > 0) lines.push(`| \`${obj}\` | ${n} |`);
    }
    lines.push(``);
    lines.push(`**Total defaulted references: ${args.totalDefaultedOwnerRefs}**`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`Plan hash: \`${args.planHash}\``);
  lines.push(``);
  lines.push(
    `To execute the full seed, call seed with ` +
      `\`{action: "run", sessionId: "<this-session>", confirm: true}\` within 24 hours. ` +
      `The run will recompute this hash from the live graph + describes; a mismatch ` +
      `means the plan drifted since dry-run and the run is refused until you re-dry-run.`,
  );

  return lines.join("\n");
}

// Referenced but not used — kept for symmetry with execute.ts. If a caller
// wants to sanity-check the chunking math, they can import this.
export { chunkIds as _chunkIds, soqlIdList as _soqlIdList };
