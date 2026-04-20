import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrgAuth } from "../auth/sf-auth.ts";
import type { DescribeClient } from "../describe/client.ts";
import type { Field, SObjectDescribe } from "../describe/types.ts";
import { isReference } from "../describe/types.ts";
import type { DependencyGraph } from "../graph/build.ts";
import { isStandardRootObject } from "../graph/standard-objects.ts";
import type { LoadPlan, LoadStep } from "../graph/order.ts";
import { ApiError, UserError } from "../errors.ts";
import {
  chunkIds,
  computeScopePaths,
  queryIds,
  queryRecords,
  soqlIdList,
  type ScopePath,
} from "./extract.ts";
import { IdMap } from "./id-map.ts";
import type { ExecuteSummary, UpsertDecisionSummary } from "./session.ts";
import {
  reactivateFromSnapshot,
  snapshotAndDeactivate,
} from "./validation-rule-toggle.ts";

/**
 * The full run. For each step of the restricted load plan:
 *
 *   single:
 *     1. SELECT createable fields + Id from source, scoped to the root.
 *     2. Substitute FK values using the session's id-map.
 *        - FK target is in id-map → use the mapped target ID.
 *        - FK target is a standard-root (User, RecordType) → leave as-is.
 *        - FK target is unmapped and field is nillable → null it.
 *        - FK target is unmapped and field is NOT nillable → skip the
 *          record (log the error) and continue; caller reviews the log.
 *     3. POST composite/sobjects in batches of 200. Capture new IDs,
 *        update id-map.
 *
 *   cycle:
 *     Phase 1 — insert every object in the SCC with breakEdge.fieldName
 *       nulled (it MUST be nillable; computeLoadOrder prefers nillable).
 *     Phase 2 — PATCH each record in the SCC whose source record had the
 *       breakEdge field set, using the id-map to resolve the reference.
 *
 * All I/O touching record data stays out of the caller's response. The
 * summary returned records only counts + log path.
 */
export type ExecuteOptions = {
  sourceAuth: OrgAuth;
  targetAuth: OrgAuth;
  sourceDescribe: DescribeClient;
  targetDescribe: DescribeClient;
  graph: DependencyGraph;
  rootObject: string;
  whereClause: string;
  finalObjectList: string[];
  loadPlan: LoadPlan;
  sessionDir: string;
  fetchFn?: typeof fetch;
  /**
   * If true, snapshot + deactivate + reactivate target-org validation
   * rules scoped to `finalObjectList` around the insert phase. Only the
   * rules that were `Active = true` at snapshot time are touched —
   * rules the user had pre-disabled are left alone.
   */
  disableValidationRules?: boolean;
  /** Session identifier — threaded into the VR snapshot file. */
  sessionId?: string;
  /** Target-org alias (for the VR snapshot file, UX only). */
  targetOrgAlias?: string;
  /**
   * Per-object upsert-key decisions produced by `runDryRun`. When an
   * object's decision is `{kind: "picked", field}`, `seedSingle` routes
   * records through composite UPSERT on that external-id — safe for
   * re-runs against a target that already has matching rows. Anything
   * else (ambiguous, missing, or map entirely absent) uses INSERT,
   * identical to pre-upsert behavior. The single source of truth is
   * what the user saw in the dry-run report.
   */
  upsertDecisions?: Record<string, UpsertDecisionSummary>;
  /**
   * User-selected "Child + 1" lookups. Forwarded to computeScopePaths and
   * composeScopeSoql so lookup-target objects get a resolvable scope.
   * See src/seed/extract.ts ScopePath kind="child-lookup".
   */
  childLookups?: Record<string, string[]>;
};

const BATCH_SIZE = 200;

export async function runExecute(opts: ExecuteOptions): Promise<ExecuteSummary> {
  const fetchFn = opts.fetchFn ?? fetch;
  const logPath = join(opts.sessionDir, "execute.log");
  const idMapPath = join(opts.sessionDir, "id-map.json");
  const completedAt = () => new Date().toISOString();

  await writeFile(logPath, "", "utf8");
  const idMap = new IdMap(idMapPath);
  await idMap.load();

  // An object may have multiple paths (e.g. both direct-parent and
  // child-lookup resolve to different ID sets). Group by object; the
  // fetchers below union records across paths, deduping by Id.
  const scopePaths = new Map<string, ScopePath[]>();
  for (const p of computeScopePaths(
    opts.graph,
    opts.rootObject,
    opts.finalObjectList,
    opts.childLookups,
  )) {
    const list = scopePaths.get(p.object) ?? [];
    list.push(p);
    scopePaths.set(p.object, list);
  }

  const insertedCounts: Record<string, number> = {};
  let errorCount = 0;
  const appendLog = async (msg: string) => {
    await appendFile(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  };

  // Pre-populate the id-map with RecordType source→target mappings,
  // keyed by DeveloperName. Every object with recordTypeInfos on both
  // source and target gets mapped. This means when a source record has
  // RecordTypeId="012XX...", rewriteRecordForTarget will swap it for the
  // target org's same-DeveloperName RT before insert. Without this step,
  // source RT IDs don't exist in the target → INVALID_CROSS_REFERENCE_KEY.
  await prepopulateStandardRootMappings({
    objects: Array.from(new Set(opts.finalObjectList)),
    sourceDescribe: opts.sourceDescribe,
    targetDescribe: opts.targetDescribe,
    idMap,
    appendLog,
  });

  // Materialize root scope IDs; every downstream scope is derived from these.
  const rootIds = await queryIds({
    auth: opts.sourceAuth,
    soql: `SELECT Id FROM ${opts.rootObject} WHERE ${opts.whereClause}`,
    fetchFn,
  });
  if (rootIds.length === 0) {
    throw new UserError(
      `WHERE clause returned 0 records on ${opts.rootObject}. Nothing to seed.`,
    );
  }
  await appendLog(`Root scope: ${rootIds.length} ${opts.rootObject} record(s).`);

  // Optional: snapshot + deactivate target-org validation rules scoped
  // to finalObjectList. Done AFTER root-scope materialization so we
  // don't touch the target if extraction fails. The reactivation runs
  // unconditionally in the finally block below.
  let vrTouchedCount = 0;
  let vrReactivationFailed: string[] | undefined;
  if (opts.disableValidationRules === true) {
    const uniqueObjects = Array.from(new Set(opts.finalObjectList));
    const snapshot = await snapshotAndDeactivate({
      auth: opts.targetAuth,
      sessionId: opts.sessionId ?? "(unknown)",
      sessionDir: opts.sessionDir,
      targetOrg: opts.targetOrgAlias ?? opts.targetAuth.alias ?? opts.targetAuth.username,
      objects: uniqueObjects,
      log: appendLog,
      fetchFn,
    });
    vrTouchedCount = snapshot.touchedCount;
  }

  try {
    for (const step of opts.loadPlan.steps) {
      if (step.kind === "single") {
        const object = step.object;
        if (!opts.finalObjectList.includes(object)) continue;
        const paths = scopePaths.get(object);
        const resolvable = (paths ?? []).filter((p) => p.kind !== "unknown");
        if (resolvable.length === 0) {
          await appendLog(`SKIP ${object}: no resolvable scope from root.`);
          insertedCounts[object] = 0;
          continue;
        }
        const res = await seedSingle({
          object,
          scopes: resolvable,
          opts,
          fetchFn,
          idMap,
          rootIds,
          appendLog,
        });
        insertedCounts[object] = res.inserted;
        errorCount += res.errors;
      } else if (step.kind === "cycle") {
        await appendLog(
          `CYCLE step with ${step.objects.length} object(s): ${step.objects.join(", ")}. ` +
            `Break edge: ${step.breakEdge !== null ? `${step.breakEdge.source}.${step.breakEdge.fieldName}→${step.breakEdge.target}` : "NONE"}`,
        );
        const res = await seedCycle({
          step,
          opts,
          fetchFn,
          idMap,
          rootIds,
          scopePaths,
          appendLog,
        });
        for (const [o, n] of Object.entries(res.inserted)) {
          insertedCounts[o] = (insertedCounts[o] ?? 0) + n;
        }
        errorCount += res.errors;
      }
      await idMap.save();
    }

    await idMap.save();
    await appendLog(
      `Run complete. inserted=${JSON.stringify(insertedCounts)} errorCount=${errorCount}`,
    );
  } finally {
    // Always attempt to reactivate — even if the insert loop threw.
    // The snapshot file is still on disk, so if this ALSO fails, the
    // pending-recovery scan will force the user to recover before
    // new work can start.
    if (opts.disableValidationRules === true) {
      try {
        const r = await reactivateFromSnapshot({
          auth: opts.targetAuth,
          sessionDir: opts.sessionDir,
          log: appendLog,
          fetchFn,
        });
        if (r.failed.length > 0) {
          vrReactivationFailed = r.failed.map((f) => f.fullName);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await appendLog(
          `VR toggle: reactivation threw unexpectedly: ${msg}. ` +
            `Snapshot file is still on disk — next tool call will prompt recovery.`,
        );
      }
    }
  }

  return {
    logPath,
    idMapPath,
    insertedCounts,
    completedAt: completedAt(),
    errorCount,
    validationRulesTouched: vrTouchedCount,
    validationRulesReactivationFailed: vrReactivationFailed,
  };
}

async function seedSingle(args: {
  object: string;
  scopes: ScopePath[];
  opts: ExecuteOptions;
  fetchFn: typeof fetch;
  idMap: IdMap;
  rootIds: string[];
  appendLog: (msg: string) => Promise<void>;
}): Promise<{ inserted: number; errors: number }> {
  const { object, scopes, opts, fetchFn, idMap, rootIds, appendLog } = args;

  const srcDescribe = await opts.sourceDescribe.describeObject(object);
  const allCreateable = pickCreateableFields(srcDescribe);
  // Drop source-only fields that the target org is missing. User explicitly
  // asked: "when this happens we need to ignore these fields". The dry-run
  // report already surfaced these names for the user to review.
  const { kept: createable, dropped } = await intersectWithTargetFields({
    object,
    candidates: allCreateable,
    targetDescribe: opts.targetDescribe,
  });
  if (dropped.length > 0) {
    await appendLog(
      `${object}: skipping ${dropped.length} source-only field(s) not present on target: ${dropped.slice(0, 20).join(", ")}${dropped.length > 20 ? ", …" : ""}`,
    );
  }
  if (createable.length === 0) {
    await appendLog(`SKIP ${object}: no createable fields after target intersection.`);
    return { inserted: 0, errors: 0 };
  }

  // Union records across every applicable path, deduping by Id.
  const byId = new Map<string, Record<string, unknown>>();
  for (const scope of scopes) {
    const soql = composeScopeSoql({
      scope,
      object,
      fields: ["Id", ...createable.map((f) => f.name)],
      rootObject: opts.rootObject,
      whereClause: opts.whereClause,
      rootIds,
    });
    if (soql === null) {
      await appendLog(`${object}: skipping path kind=${scope.kind} (unable to compose SOQL).`);
      continue;
    }
    const subRecords = await queryRecords({
      auth: opts.sourceAuth,
      soql,
      fetchFn,
    });
    for (const r of subRecords) {
      const id = (r as { Id?: unknown }).Id;
      if (typeof id === "string") byId.set(id, r);
    }
    await appendLog(
      `${object}: path kind=${scope.kind} fetched ${subRecords.length} record(s) (union now ${byId.size}).`,
    );
  }
  const records = [...byId.values()];
  if (records.length === 0) {
    await appendLog(`SKIP ${object}: no records returned by any scope path.`);
    return { inserted: 0, errors: 0 };
  }
  await appendLog(`${object}: total unique source record(s) across paths: ${records.length}.`);

  // Resolve the upsert decision for this object. `picked` → route records
  // whose external-id value is populated through composite UPSERT; records
  // missing that value still go through INSERT (composite UPSERT rejects
  // the whole request if any row lacks the key). `ambiguous` or absent →
  // INSERT for every row (pre-upsert behavior).
  const decision = opts.upsertDecisions?.[object];
  const upsertField =
    decision !== undefined && decision.kind === "picked" ? decision.field : null;
  if (upsertField !== null) {
    await appendLog(
      `${object}: UPSERT on external-id ${upsertField}; rows with blank ${upsertField} fall back to INSERT.`,
    );
  } else if (decision !== undefined && decision.kind === "ambiguous") {
    await appendLog(
      `${object}: INSERT (upsert-key ambiguous: ${decision.reason} — ${decision.detail}).`,
    );
  }

  let inserted = 0;
  let errors = 0;
  for (const chunk of chunkIds(records, BATCH_SIZE)) {
    // Split rewrites into an UPSERT bucket (ext-id populated) and an
    // INSERT bucket (no ext-id value, or no picked key). We dispatch
    // them in separate requests; both feed the same id-map with
    // identical semantics: a successful composite response yields the
    // target Id whether `created` is true or false.
    const upsertRewrites: Array<{ body: Record<string, unknown>; sourceId: string }> = [];
    const insertRewrites: Array<{ body: Record<string, unknown>; sourceId: string }> = [];
    for (const rec of chunk) {
      const rewritten = rewriteRecordForTarget(object, rec, createable, idMap);
      if (rewritten === null) continue;
      const srcId = (rec as Record<string, unknown>).Id;
      const sourceId = typeof srcId === "string" ? srcId : "";

      if (upsertField !== null) {
        const v = rewritten[upsertField];
        if (v !== null && v !== undefined && v !== "") {
          upsertRewrites.push({ body: rewritten, sourceId });
          continue;
        }
      }
      insertRewrites.push({ body: rewritten, sourceId });
    }

    const skipped = chunk.length - (upsertRewrites.length + insertRewrites.length);
    if (skipped > 0) {
      errors += skipped;
      await appendLog(`${object}: skipped ${skipped} record(s) due to unresolved required FKs.`);
    }

    if (upsertRewrites.length > 0 && upsertField !== null) {
      const results = await compositeUpsert({
        auth: opts.targetAuth,
        object,
        externalIdField: upsertField,
        records: upsertRewrites.map((r) => r.body),
        fetchFn,
      });
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sourceId = upsertRewrites[i].sourceId;
        if (r.success && typeof r.id === "string" && sourceId.length > 0) {
          // `created` tells us whether Salesforce inserted or matched.
          // Either way the target id is authoritative; id-map stores it
          // so downstream FK rewrites resolve correctly for both cases.
          idMap.set(object, sourceId, r.id);
          inserted++;
        } else {
          errors++;
          await appendLog(
            `${object}: upsert failed for sourceId=${sourceId} — ${JSON.stringify(r.errors ?? [])}`,
          );
        }
      }
    }

    if (insertRewrites.length > 0) {
      const results = await compositeInsert({
        auth: opts.targetAuth,
        object,
        records: insertRewrites.map((r) => r.body),
        fetchFn,
      });
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sourceId = insertRewrites[i].sourceId;
        if (r.success && typeof r.id === "string" && sourceId.length > 0) {
          idMap.set(object, sourceId, r.id);
          inserted++;
        } else {
          errors++;
          await appendLog(
            `${object}: insert failed for sourceId=${sourceId} — ${JSON.stringify(r.errors ?? [])}`,
          );
        }
      }
    }
  }

  await appendLog(`${object}: inserted=${inserted} errors=${errors}`);
  return { inserted, errors };
}

async function seedCycle(args: {
  step: Extract<LoadStep, { kind: "cycle" }>;
  opts: ExecuteOptions;
  fetchFn: typeof fetch;
  idMap: IdMap;
  rootIds: string[];
  scopePaths: Map<string, ScopePath[]>;
  appendLog: (msg: string) => Promise<void>;
}): Promise<{ inserted: Record<string, number>; errors: number }> {
  const { step, opts, fetchFn, idMap, rootIds, scopePaths, appendLog } = args;

  if (step.breakEdge === null) {
    await appendLog(
      `SKIP cycle ${step.objects.join(",")}: no nillable break edge available.`,
    );
    return { inserted: {}, errors: 0 };
  }

  const inserted: Record<string, number> = {};
  let errors = 0;

  // Phase 1: insert every object with the break-edge field nulled.
  // We remember which records had a non-null break-edge value so phase 2
  // knows which to update.
  const breakSource = step.breakEdge.source;
  const breakField = step.breakEdge.fieldName;

  // recordsBySourceId[object][sourceId] = originalRecord
  const recordsBySourceId = new Map<string, Map<string, Record<string, unknown>>>();

  for (const object of step.objects) {
    if (!opts.finalObjectList.includes(object)) continue;
    const paths = (scopePaths.get(object) ?? []).filter((p) => p.kind !== "unknown");
    if (paths.length === 0) {
      await appendLog(`SKIP ${object} in cycle: no scope.`);
      continue;
    }
    const srcDescribe = await opts.sourceDescribe.describeObject(object);
    const allCreateable = pickCreateableFields(srcDescribe);
    const { kept: createable, dropped } = await intersectWithTargetFields({
      object,
      candidates: allCreateable,
      targetDescribe: opts.targetDescribe,
    });
    if (dropped.length > 0) {
      await appendLog(
        `${object} [cycle]: skipping ${dropped.length} source-only field(s) not present on target: ${dropped.slice(0, 20).join(", ")}${dropped.length > 20 ? ", …" : ""}`,
      );
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const scope of paths) {
      const soql = composeScopeSoql({
        scope,
        object,
        fields: ["Id", ...createable.map((f) => f.name)],
        rootObject: opts.rootObject,
        whereClause: opts.whereClause,
        rootIds,
      });
      if (soql === null) continue;
      const subRecords = await queryRecords({ auth: opts.sourceAuth, soql, fetchFn });
      for (const r of subRecords) {
        const id = (r as { Id?: unknown }).Id;
        if (typeof id === "string") byId.set(id, r);
      }
    }
    const records = [...byId.values()];
    await appendLog(`${object} [cycle phase 1]: unioned ${records.length} source record(s) across ${paths.length} path(s).`);

    const perIdMap = new Map<string, Record<string, unknown>>();
    for (const r of records) {
      const id = (r as Record<string, unknown>).Id;
      if (typeof id === "string") perIdMap.set(id, r);
    }
    recordsBySourceId.set(object, perIdMap);

    let objectInserted = 0;
    for (const chunk of chunkIds(records, BATCH_SIZE)) {
      const payload: Array<Record<string, unknown>> = [];
      const sourceIdsForInserted: string[] = [];
      for (const rec of chunk) {
        const rewritten = rewriteRecordForTarget(object, rec, createable, idMap);
        if (rewritten === null) {
          errors++;
          continue;
        }
        // Null the break-edge field on the source of the break edge during phase 1.
        if (object === breakSource) {
          rewritten[breakField] = null;
        }
        payload.push(rewritten);
        const srcId = (rec as Record<string, unknown>).Id;
        sourceIdsForInserted.push(typeof srcId === "string" ? srcId : "");
      }

      if (payload.length === 0) continue;
      const results = await compositeInsert({
        auth: opts.targetAuth,
        object,
        records: payload,
        fetchFn,
      });
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sourceId = sourceIdsForInserted[i];
        if (r.success && typeof r.id === "string" && sourceId.length > 0) {
          idMap.set(object, sourceId, r.id);
          objectInserted++;
        } else {
          errors++;
          await appendLog(
            `${object} [cycle phase 1]: insert failed for sourceId=${sourceId} — ${JSON.stringify(r.errors ?? [])}`,
          );
        }
      }
    }
    inserted[object] = (inserted[object] ?? 0) + objectInserted;
  }

  // Phase 2: for each source record of `breakSource` with a non-null break-edge
  // value, PATCH the target record to set the break-edge field to the mapped ID.
  const sourceSideRecords = recordsBySourceId.get(breakSource);
  if (sourceSideRecords !== undefined) {
    const updates: Array<{ sourceId: string; targetId: string; fkTargetId: string }> = [];
    for (const [sourceId, rec] of sourceSideRecords) {
      const val = (rec as Record<string, unknown>)[breakField];
      if (typeof val !== "string" || val.length === 0) continue;
      const mappedTarget = idMap.get(step.breakEdge.target, val);
      const mappedSelf = idMap.get(breakSource, sourceId);
      if (mappedTarget === undefined || mappedSelf === undefined) continue;
      updates.push({ sourceId, targetId: mappedSelf, fkTargetId: mappedTarget });
    }
    await appendLog(
      `${breakSource} [cycle phase 2]: ${updates.length} record(s) to backfill ${breakField}.`,
    );
    for (const u of updates) {
      try {
        await patchRecord({
          auth: opts.targetAuth,
          object: breakSource,
          targetId: u.targetId,
          body: { [breakField]: u.fkTargetId },
          fetchFn,
        });
      } catch (err) {
        errors++;
        await appendLog(
          `${breakSource} [cycle phase 2]: PATCH failed for targetId=${u.targetId} — ${(err as Error).message}`,
        );
      }
    }
  }

  return { inserted, errors };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Populate the id-map with source→target mappings for standard-root objects
 * that we CAN resolve deterministically from describe metadata:
 *
 *   RecordType — matched by (SobjectType + DeveloperName). Each object's
 *     `describe.recordTypeInfos` gives us `{developerName, recordTypeId}`
 *     for every RT on both source and target. We match by developerName
 *     and write the pair into the id-map under key `RecordType:<srcId>`.
 *
 * Other standard-roots (User, BusinessHours, Group, Queue) could in
 * principle be mapped by DeveloperName too, but that requires a SOQL
 * query against both orgs. Punting to a follow-up; for now the
 * rewriteRecordForTarget logic omits unresolvable standard-root FKs so
 * Salesforce's default picker kicks in.
 *
 * Exported for unit testing.
 */
export async function prepopulateStandardRootMappings(args: {
  objects: string[];
  sourceDescribe: DescribeClient;
  targetDescribe: DescribeClient;
  idMap: IdMap;
  appendLog?: (msg: string) => Promise<void>;
}): Promise<{ mappedCount: number; unmappedByObject: Record<string, string[]> }> {
  const unmappedByObject: Record<string, string[]> = {};
  let mappedCount = 0;

  for (const object of args.objects) {
    let srcDesc;
    let tgtDesc;
    try {
      srcDesc = await args.sourceDescribe.describeObject(object);
    } catch {
      continue;
    }
    try {
      tgtDesc = await args.targetDescribe.describeObject(object);
    } catch {
      continue;
    }
    const srcRTs = srcDesc.recordTypeInfos ?? [];
    const tgtRTs = tgtDesc.recordTypeInfos ?? [];
    if (srcRTs.length === 0 || tgtRTs.length === 0) continue;

    const tgtByDevName = new Map<string, string>();
    for (const rt of tgtRTs) {
      if (typeof rt.recordTypeId === "string" && rt.recordTypeId.length > 0) {
        tgtByDevName.set(rt.developerName, rt.recordTypeId);
      }
    }

    const unmapped: string[] = [];
    for (const rt of srcRTs) {
      const srcId = rt.recordTypeId;
      if (typeof srcId !== "string" || srcId.length === 0) continue;
      const tgtId = tgtByDevName.get(rt.developerName);
      if (tgtId !== undefined) {
        args.idMap.set("RecordType", srcId, tgtId);
        mappedCount++;
      } else {
        unmapped.push(rt.developerName);
      }
    }
    if (unmapped.length > 0) {
      unmappedByObject[object] = unmapped;
      if (args.appendLog !== undefined) {
        await args.appendLog(
          `${object}: ${unmapped.length} source RecordType(s) have no target match by DeveloperName (${unmapped.slice(0, 5).join(", ")}${unmapped.length > 5 ? ", …" : ""}). Records using these RTs will omit RecordTypeId — Salesforce default will apply.`,
        );
      }
    }
  }

  if (args.appendLog !== undefined && mappedCount > 0) {
    await args.appendLog(
      `Pre-populated id-map with ${mappedCount} RecordType mapping(s) by DeveloperName.`,
    );
  }
  return { mappedCount, unmappedByObject };
}

/**
 * Intersect source createable fields with the target org's actual field
 * list, dropping any source-only fields. Returns the surviving set plus
 * the names of anything dropped (for logging).
 *
 * If the target describe fails (object missing in target entirely, auth
 * error, etc.) we fall back to keeping all candidates — the composite
 * insert will surface the real error with better context than we can.
 *
 * Exported for unit testing.
 */
export async function intersectWithTargetFields(args: {
  object: string;
  candidates: Field[];
  targetDescribe: DescribeClient;
}): Promise<{ kept: Field[]; dropped: string[] }> {
  let targetFieldNames: Set<string>;
  try {
    const td = await args.targetDescribe.describeObject(args.object);
    targetFieldNames = new Set(td.fields.map((f) => f.name));
  } catch {
    return { kept: args.candidates, dropped: [] };
  }
  const kept: Field[] = [];
  const dropped: string[] = [];
  for (const f of args.candidates) {
    if (targetFieldNames.has(f.name)) kept.push(f);
    else dropped.push(f.name);
  }
  return { kept, dropped };
}

/**
 * Fields we send on insert. We intentionally do NOT filter on
 * `defaultedOnCreate` — that flag means "Salesforce has a default if
 * you omit this," not "don't send this." It's set on user-settable
 * fields including the custom-object `Name` text field, `OwnerId`, and
 * `RecordTypeId`. Filtering on it would blank out Name on every custom
 * object with a text (non-autonumber) Name, and the Lightning UI would
 * fall back to displaying the raw Record ID in list views.
 *
 * The unmappable-standard-root FK case (OwnerId with a source user that
 * doesn't exist in the target) is already handled by
 * `rewriteRecordForTarget`, which omits unresolvable standard-root
 * references from the body so Salesforce applies the running user's
 * default. Dropping `defaultedOnCreate` here does not regress that path.
 *
 * `createable: false` still excludes the truly system-owned fields
 * (CreatedDate, SystemModstamp, LastModifiedById, audit fields).
 */
function pickCreateableFields(describe: SObjectDescribe): Field[] {
  return describe.fields.filter((f) => {
    if (f.name === "Id") return false;
    if (f.createable === false) return false;
    if (f.calculated === true) return false;
    return true;
  });
}

/**
 * Compose a `SELECT <fields> FROM <object>` with a WHERE clause appropriate
 * to how this object relates to the root (direct parent / direct child /
 * root itself). Returns null if the path is unknown or transitive (v1
 * doesn't materialize full transitive chains).
 */
function composeScopeSoql(args: {
  scope: ScopePath;
  object: string;
  fields: string[];
  rootObject: string;
  whereClause: string;
  rootIds: string[];
}): string | null {
  const fieldList = args.fields.join(", ");
  switch (args.scope.kind) {
    case "root":
      return `SELECT ${fieldList} FROM ${args.object} WHERE ${args.whereClause}`;
    case "direct-parent": {
      if (args.scope.rootFk === undefined) return null;
      // Materialize root IDs to avoid nested semi-join when the user's
      // WHERE already contains one (Salesforce forbids 2+ levels).
      const idList = soqlIdList(args.rootIds);
      if (idList.length === 0) return null;
      return (
        `SELECT ${fieldList} FROM ${args.object} ` +
        `WHERE Id IN (SELECT ${args.scope.rootFk} FROM ${args.rootObject} WHERE Id IN (${idList}))`
      );
    }
    case "direct-child": {
      if (args.scope.childFk === undefined) return null;
      // Prefer a subquery over materialized IDs — shorter HTTP payload.
      if (args.rootIds.length <= 2000) {
        const idList = soqlIdList(args.rootIds);
        if (idList.length === 0) return null;
        return `SELECT ${fieldList} FROM ${args.object} WHERE ${args.scope.childFk} IN (${idList})`;
      }
      return (
        `SELECT ${fieldList} FROM ${args.object} ` +
        `WHERE ${args.scope.childFk} IN (SELECT Id FROM ${args.rootObject} WHERE ${args.whereClause})`
      );
    }
    case "child-lookup": {
      const { childObject, lookupField, childFkToRoot } = args.scope;
      if (
        childObject === undefined ||
        lookupField === undefined ||
        childFkToRoot === undefined
      )
        return null;
      // One level of SOQL nesting: materialize root IDs as a literal list
      // for the innermost filter. This keeps us within Salesforce's "only
      // one semi-join" limit (which would fire if we left the root scope
      // as its own subquery).
      const idList = soqlIdList(args.rootIds);
      if (idList.length === 0) return null;
      return (
        `SELECT ${fieldList} FROM ${args.object} ` +
        `WHERE Id IN (SELECT ${lookupField} FROM ${childObject} ` +
        `WHERE ${childFkToRoot} IN (${idList}))`
      );
    }
    default:
      return null;
  }
}

/**
 * Build the insert-ready record body: strip Id, attributes, unknown fields;
 * rewrite reference values via id-map. Returns null if a non-nillable
 * reference can't be resolved (caller logs + skips).
 */
function rewriteRecordForTarget(
  object: string,
  record: Record<string, unknown>,
  createable: Field[],
  idMap: IdMap,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = { attributes: { type: object } };
  const byName = new Map<string, Field>();
  for (const f of createable) byName.set(f.name, f);

  for (const [key, value] of Object.entries(record)) {
    if (key === "Id" || key === "attributes") continue;
    const field = byName.get(key);
    if (field === undefined) continue;

    if (value === null || value === undefined) {
      body[key] = null;
      continue;
    }

    if (isReference(field) && typeof value === "string") {
      // Resolve the FK using the id-map. The field can point to multiple
      // objects (polymorphic) — we try each referenceTo in turn.
      //
      // Key ordering: we check `idMap.get(target, value)` FIRST for every
      // target, including standard-roots. This matters because RecordType
      // IS a standard-root but we DO pre-populate the id-map with
      // RecordType mappings (by DeveloperName) in
      // `prepopulateStandardRootMappings`. If we short-circuited on
      // `isStandardRootObject` before consulting the map, RecordType
      // remapping would never fire.
      let resolved: string | null = null;
      let anyStandard = false;
      for (const target of field.referenceTo) {
        const mapped = idMap.get(target, value);
        if (mapped !== undefined) {
          resolved = mapped;
          break;
        }
        if (isStandardRootObject(target)) anyStandard = true;
      }
      if (resolved !== null) {
        body[key] = resolved;
      } else if (anyStandard) {
        // Unmappable standard-root FK (OwnerId, unmapped RecordTypeId,
        // BusinessHoursId, etc.). OMIT the field entirely rather than
        // sending `null` — explicit `null` can trigger
        // INVALID_CROSS_REFERENCE_KEY when the running user has no
        // default for the object (e.g. no default RecordType on
        // Acme Dev). Omission lets Salesforce fill the default
        // from the running user's profile.
        // (don't touch body[key])
      } else if (field.nillable) {
        body[key] = null;
      } else {
        return null; // non-nillable FK, no mapping — caller skips + logs.
      }
      continue;
    }

    body[key] = value;
  }

  return body;
}

type CompositeResult = {
  id?: string;
  success: boolean;
  /** True when the row was newly inserted, false when matched on external id. Only set on UPSERT responses. */
  created?: boolean;
  errors?: unknown[];
};

/**
 * Composite UPSERT on an external-id field.
 *
 * Endpoint: `PATCH /services/data/vN/composite/sobjects/<Object>/<ExtIdField>`
 * Body: `{allOrNone: false, records: [{attributes: {type: "<Object>"}, <ExtIdField>: value, ...other fields}]}`
 * Response: same shape as composite insert, plus a `created: boolean`
 *   per row distinguishing insert from match-and-update.
 *
 * Caller guarantees every record has a non-empty value at
 * `args.externalIdField`; records without are routed through plain
 * INSERT by `seedSingle` (composite UPSERT rejects the entire batch
 * if any row is missing the key).
 */
async function compositeUpsert(args: {
  auth: OrgAuth;
  object: string;
  externalIdField: string;
  records: Array<Record<string, unknown>>;
  fetchFn: typeof fetch;
}): Promise<CompositeResult[]> {
  const url =
    `${args.auth.instanceUrl}/services/data/v${args.auth.apiVersion}` +
    `/composite/sobjects/${encodeURIComponent(args.object)}/${encodeURIComponent(args.externalIdField)}`;
  const res = await args.fetchFn(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${args.auth.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      allOrNone: false,
      records: args.records,
    }),
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new ApiError(
      `composite/sobjects/${args.object}/${args.externalIdField} PATCH failed (${res.status}): ${body}`,
    );
  }
  try {
    return (await res.json()) as CompositeResult[];
  } catch (err) {
    throw new ApiError(
      `composite/sobjects upsert returned non-JSON: ${(err as Error).message}`,
    );
  }
}

async function compositeInsert(args: {
  auth: OrgAuth;
  object: string;
  records: Array<Record<string, unknown>>;
  fetchFn: typeof fetch;
}): Promise<CompositeResult[]> {
  const url = `${args.auth.instanceUrl}/services/data/v${args.auth.apiVersion}/composite/sobjects`;
  const res = await args.fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.auth.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      allOrNone: false,
      records: args.records,
    }),
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new ApiError(`composite/sobjects POST failed (${res.status}): ${body}`);
  }
  try {
    return (await res.json()) as CompositeResult[];
  } catch (err) {
    throw new ApiError(
      `composite/sobjects returned non-JSON: ${(err as Error).message}`,
    );
  }
}

async function patchRecord(args: {
  auth: OrgAuth;
  object: string;
  targetId: string;
  body: Record<string, unknown>;
  fetchFn: typeof fetch;
}): Promise<void> {
  const url = `${args.auth.instanceUrl}/services/data/v${args.auth.apiVersion}/sobjects/${encodeURIComponent(args.object)}/${encodeURIComponent(args.targetId)}`;
  const res = await args.fetchFn(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${args.auth.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args.body),
  });
  if (!res.ok && res.status !== 204) {
    const body = await safeText(res);
    throw new ApiError(`PATCH ${args.object}/${args.targetId} failed (${res.status}): ${body}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
