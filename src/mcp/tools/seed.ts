import { z } from "zod";
import type { OrgAuth } from "../../auth/sf-auth.ts";
import { resolveAuth } from "../../auth/sf-auth.ts";
import { DescribeCache } from "../../describe/cache.ts";
import { DescribeClient } from "../../describe/client.ts";
import { ApiError, UserError } from "../../errors.ts";
import { computeLoadOrder } from "../../graph/order.ts";
import { runInspect } from "../../inspect/run.ts";
import { classifyForSeed } from "../../seed/classify.ts";
import { runDryRun } from "../../seed/dry-run.ts";
import { runExecute } from "../../seed/execute.ts";
import {
  queryCount,
  queryIds,
  soqlIdList,
  validateWhereClause,
} from "../../seed/extract.ts";
import {
  DRY_RUN_FRESHNESS_MS,
  isDryRunFresh,
  SessionStore,
  type Session,
} from "../../seed/session.ts";
import {
  findPendingRecoveries,
  reactivateFromSnapshot,
} from "../../seed/validation-rule-toggle.ts";
import { queryActiveValidationRules } from "../../describe/tooling-client.ts";

/**
 * The ONE MCP tool.
 *
 * The AI drives the user through a multi-step seeding flow by calling
 * this tool repeatedly with `action` set to: start → analyze → select →
 * dry_run → run. A `sessionId` carries state between calls.
 *
 * Design principle: every response payload is **metadata only**. No
 * record IDs, no field values, no row bodies. The existing AI-boundary
 * enforcement test (`tests/mcp/ai-boundary.test.ts`) covers this tool
 * across every action.
 *
 * Record-bearing artifacts (scope IDs, insert logs) land on disk under
 * `~/.sandbox-seed/sessions/<id>/`. The tool response references them
 * by path; the LLM sees the path, not the contents.
 */

const API_VERSION = "60.0";
const DEFAULT_SCOPE_LIMIT = 10_000;

export const SeedArgs = z.object({
  action: z
    .enum([
      "start",
      "analyze",
      "select",
      "dry_run",
      "run",
      "recover_validation_rules",
    ])
    .describe(
      "Which step of the seed flow to execute. `recover_validation_rules` is a " +
        "safety-net action — run it when a prior session left target-org " +
        "validation rules deactivated (the tool will refuse new work until then).",
    ),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Required for analyze/select/dry_run/run. Returned by `start`."),
  sourceOrg: z
    .string()
    .min(1)
    .optional()
    .describe("Source Salesforce org alias (required for start)."),
  targetOrg: z
    .string()
    .min(1)
    .optional()
    .describe("Target (sandbox) Salesforce org alias (required for start)."),
  object: z
    .string()
    .min(1)
    .optional()
    .describe("Root sObject API name to seed (required for start)."),
  whereClause: z
    .string()
    .min(1)
    .optional()
    .describe(
      "SOQL WHERE clause scoping which root records to seed. Required for start. " +
        "MUST be a real SOQL predicate typed by the user — do not invent one. " +
        "The tool validates it against the source org; malformed clauses are rejected.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Safety cap on the root-scope count. Default ${DEFAULT_SCOPE_LIMIT}. If the WHERE ` +
        `clause matches MORE than this, \`start\` rejects. To select N-of-many deterministically, ` +
        `use \`sampleSize\` instead.`,
    ),
  sampleSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Sample size — when set, take the FIRST N matching root records (ORDER BY Id) " +
        "and seed only those. Use this for quick smoke-tests or previews. Example: " +
        "`sampleSize: 10` picks 10 of however many records match, instead of rejecting.",
    ),
  includeOptionalParents: z
    .array(z.string())
    .optional()
    .describe("For action=select. Names of optional parent objects to include."),
  includeOptionalChildren: z
    .array(z.string())
    .optional()
    .describe("For action=select. Names of optional child objects to include."),
  includeManagedPackages: z
    .boolean()
    .optional()
    .describe(
      "For action=analyze. When true, surfaces managed-package parents/children (e.g. " +
        "`APXTConga4__Contract__c`) in the optional lists. Default false — noisy on most orgs.",
    ),
  includeSystemChildren: z
    .boolean()
    .optional()
    .describe(
      "For action=analyze. When true, surfaces system-automation children (Feed*, *History, " +
        "ProcessInstance, EntitySubscription, …) in the optional child list. Default false.",
    ),
  confirm: z
    .literal(true)
    .optional()
    .describe("For action=run. Must be `true` — acts as the final confirmation gate."),
  disableValidationRulesOnRun: z
    .boolean()
    .optional()
    .describe(
      "For action=start. When true, `run` will snapshot + deactivate + reactivate " +
        "every target-org validation rule on the seeded objects. ONLY rules that " +
        "were Active=true at snapshot time are touched — rules the user had " +
        "pre-disabled are left alone. If the process crashes between deactivate " +
        "and reactivate, the next tool call refuses new work until the user runs " +
        "`action: \"recover_validation_rules\"`. Default false.",
    ),
});

export type SeedArgsT = z.infer<typeof SeedArgs>;

/** Overrides for tests — allow injecting the session root, describe caches, and fetch. */
export type SeedOverrides = {
  sessionRootDir?: string;
  cacheRoot?: string;
  fetchFn?: typeof fetch;
  /** If provided, skips resolveAuth() for the given alias. */
  authBySource?: OrgAuth;
  authByTarget?: OrgAuth;
};

export type SeedResponse = {
  sessionId: string;
  step: Session["step"];
  action: SeedArgsT["action"];
  summary: Record<string, unknown>;
  nextAction: SeedArgsT["action"] | null;
  guidance: string;
};

export async function seed(
  args: SeedArgsT,
  overrides: SeedOverrides = {},
): Promise<SeedResponse> {
  const store = new SessionStore({ rootDir: overrides.sessionRootDir });
  await store.gc().catch(() => {
    /* GC failure is never fatal */
  });

  // Global pending-recovery guard. If ANY prior session left validation
  // rules deactivated on the target, refuse new work until the user
  // reactivates them. The recovery action itself is exempt (obviously).
  if (args.action !== "recover_validation_rules") {
    const pending = await findPendingRecoveries(store.sessionsRoot()).catch(
      () => [],
    );
    if (pending.length > 0) {
      const list = pending
        .map(
          (p) =>
            `  - session "${p.sessionId}" (target=${p.targetOrg}, snapshotted ${p.snapshotAt}): ${p.count} rule(s)`,
        )
        .join("\n");
      throw new UserError(
        `Refusing new work — ${pending.length} prior session(s) left target-org ` +
          `validation rule(s) deactivated:\n${list}`,
        `Call sandbox_seed_seed with action: "recover_validation_rules", sessionId: "<id>" ` +
          `for each session above. Only then can you start/continue a seed flow.`,
      );
    }
  }

  switch (args.action) {
    case "start":
      return await doStart(args, store, overrides);
    case "analyze":
      return await doAnalyze(args, store, overrides);
    case "select":
      return await doSelect(args, store, overrides);
    case "dry_run":
      return await doDryRun(args, store, overrides);
    case "run":
      return await doRun(args, store, overrides);
    case "recover_validation_rules":
      return await doRecoverValidationRules(args, store, overrides);
  }
}

// ────────────────────────────────────────────────────────────────────
// start
// ────────────────────────────────────────────────────────────────────

async function doStart(
  args: SeedArgsT,
  store: SessionStore,
  overrides: SeedOverrides,
): Promise<SeedResponse> {
  if (args.sourceOrg === undefined) requireField("sourceOrg", "start");
  if (args.targetOrg === undefined) requireField("targetOrg", "start");
  if (args.object === undefined) requireField("object", "start");
  if (args.whereClause === undefined) requireField("whereClause", "start");
  const limit = args.limit ?? DEFAULT_SCOPE_LIMIT;

  const sourceAuth = overrides.authBySource ?? (await resolveAuth(args.sourceOrg, API_VERSION));
  const targetAuth = overrides.authByTarget ?? (await resolveAuth(args.targetOrg, API_VERSION));

  // Target must be a sandbox. Query Organization.IsSandbox rather than rely
  // on sf-CLI's classification, which gets stale.
  const isSandbox = await checkIsSandbox({ auth: targetAuth, fetchFn: overrides.fetchFn });
  if (isSandbox !== true) {
    throw new UserError(
      `Target org "${args.targetOrg}" is not a sandbox (Organization.IsSandbox=false). ` +
        `Refusing to seed into a production org.`,
      `Pick a sandbox alias for --target-org.`,
    );
  }

  // Validate object exists in source.
  const sourceCache = new DescribeCache({
    orgId: sourceAuth.orgId,
    ttlSeconds: 86400,
    cacheRoot: overrides.cacheRoot,
  });
  const sourceDesc = new DescribeClient({
    auth: sourceAuth,
    cache: sourceCache,
    fetchFn: overrides.fetchFn,
  });
  const global = await sourceDesc.describeGlobal();
  const known = new Set(global.sobjects.map((s) => s.name));
  if (!known.has(args.object!)) {
    throw new UserError(
      `Object "${args.object}" not found in source org "${args.sourceOrg}".`,
      `Check spelling. Custom objects need the __c suffix.`,
    );
  }

  // Validate WHERE clause by running SELECT COUNT() against source.
  const matchedCount = await validateWhereClause({
    auth: sourceAuth,
    object: args.object!,
    whereClause: args.whereClause!,
    fetchFn: overrides.fetchFn,
  });

  if (matchedCount === 0) {
    throw new UserError(
      `WHERE clause matched 0 records on ${args.object}.`,
      `No records to seed — check your clause.`,
    );
  }

  // sampleSize: take the first N deterministically and rewrite scope
  // to `Id IN (…sampled IDs…)`. This is the "LIMIT 10 of 162" semantic
  // the user wanted. `limit` stays as a hard cap — even with sampleSize,
  // we refuse to materialize more IDs than `limit`.
  let effectiveWhereClause = args.whereClause!;
  let scopeCount = matchedCount;
  let sampleApplied = false;

  if (args.sampleSize !== undefined) {
    if (args.sampleSize > limit) {
      throw new UserError(
        `sampleSize ${args.sampleSize} exceeds limit ${limit}.`,
        `Raise \`limit\` or lower \`sampleSize\`.`,
      );
    }
    if (args.sampleSize < matchedCount) {
      const sampledIds = await queryIds({
        auth: sourceAuth,
        soql:
          `SELECT Id FROM ${args.object} WHERE ${args.whereClause} ` +
          `ORDER BY Id LIMIT ${args.sampleSize}`,
        fetchFn: overrides.fetchFn,
      });
      if (sampledIds.length === 0) {
        throw new UserError(
          `Failed to materialize sample of size ${args.sampleSize}.`,
          `The query returned no IDs — try a broader WHERE clause.`,
        );
      }
      effectiveWhereClause = `(${args.whereClause}) AND Id IN (${soqlIdList(sampledIds)})`;
      scopeCount = sampledIds.length;
      sampleApplied = true;
    } else {
      // sampleSize >= matchedCount: no sampling needed, full scope fits.
      scopeCount = matchedCount;
    }
  } else if (matchedCount > limit) {
    throw new UserError(
      `WHERE clause matched ${matchedCount} records, exceeding limit ${limit}.`,
      `Narrow the clause, pass a larger \`limit\`, or use \`sampleSize: N\` to take the first N records.`,
    );
  }

  const session = await store.create({
    sourceOrg: args.sourceOrg!,
    targetOrg: args.targetOrg!,
    rootObject: args.object!,
    whereClause: effectiveWhereClause,
    limit,
    scopeCount,
    disableValidationRulesOnRun: args.disableValidationRulesOnRun === true,
  });

  return {
    sessionId: session.id,
    step: "started",
    action: "start",
    summary: {
      sourceOrg: session.sourceOrg,
      targetOrg: session.targetOrg,
      rootObject: session.rootObject,
      whereClause: args.whereClause!, // surface the user's original clause, not the rewritten one
      matchedCount,
      scopeCount,
      limit,
      sampleApplied,
      disableValidationRulesOnRun: session.disableValidationRulesOnRun === true,
    },
    nextAction: "analyze",
    guidance: sampleApplied
      ? `Matched ${matchedCount} ${session.rootObject} record(s) — sampled first ${scopeCount} ` +
        `(ORDER BY Id). Next: call sandbox_seed_seed with action: "analyze".`
      : `Scope: ${scopeCount} ${session.rootObject} record(s) in ${session.sourceOrg} match the WHERE clause. ` +
        `Confirm this is the scope the user wanted, then call sandbox_seed_seed with action: "analyze".`,
  };
}

// ────────────────────────────────────────────────────────────────────
// analyze
// ────────────────────────────────────────────────────────────────────

async function doAnalyze(
  args: SeedArgsT,
  store: SessionStore,
  overrides: SeedOverrides,
): Promise<SeedResponse> {
  const session = await loadSession(args, store);
  const sourceAuth = overrides.authBySource ?? (await resolveAuth(session.sourceOrg, API_VERSION));

  const result = await runInspect({
    auth: sourceAuth,
    rootObject: session.rootObject,
    parentWalkDepth: 2,
    includeChildren: true,
    includeCounts: false,
    cacheTtlSeconds: 86400,
    bypassCache: false,
    cacheRoot: overrides.cacheRoot,
    fetchFn: overrides.fetchFn,
  });

  const classification = classifyForSeed({
    graph: result.graph,
    rootObject: session.rootObject,
    parentObjects: result.parentObjects,
    childObjects: result.childObjects,
    includeManagedPackages: args.includeManagedPackages === true,
    includeSystemChildren: args.includeSystemChildren === true,
  });

  // Analyze-time load order is pre-select: restrict to root + must-include
  // parents so we don't dump 200 object names of full-graph cruft into the
  // agent's context. Cycles relevant to the minimum seed set are still
  // surfaced separately via `cycleCount` + `cycles`.
  const minimumObjects = [session.rootObject, ...classification.mustIncludeParents];
  const minimumPlan = computeLoadOrder(result.graph, { requestedObjects: minimumObjects });
  const minimumLoadOrder = loadOrderObjects(minimumPlan.steps);
  // Still persist the full plan on disk for diagnostic use — but the LLM
  // only sees the minimum.
  const fullLoadOrder = loadOrderObjects(result.plan.steps);
  const cycles = result.cycles.map((c) => ({
    objects: c.nodes,
    breakEdge: c.breakEdge,
  }));

  session.mustIncludeParents = classification.mustIncludeParents;
  session.optionalParents = classification.optionalParents;
  session.optionalChildren = classification.optionalChildren;
  session.cycles = cycles;
  session.analyzedLoadOrder = fullLoadOrder;
  session.step = "analyzed";
  await store.save(session);

  const totalHidden =
    classification.hiddenManagedParentCount +
    classification.hiddenManagedChildCount +
    classification.hiddenSystemChildCount;
  const hiddenHint =
    totalHidden > 0
      ? ` (${classification.hiddenManagedParentCount} managed-package parent(s), ` +
        `${classification.hiddenManagedChildCount} managed-package child(ren), ` +
        `${classification.hiddenSystemChildCount} system-automation child(ren) hidden — ` +
        `re-run with \`includeManagedPackages: true\` or \`includeSystemChildren: true\` to see them)`
      : "";

  return {
    sessionId: session.id,
    step: session.step,
    action: "analyze",
    summary: {
      rootObject: session.rootObject,
      mustIncludeParents: classification.mustIncludeParents,
      optionalParents: classification.optionalParents,
      optionalChildren: classification.optionalChildren,
      standardRootsReferenced: classification.standardRoots,
      loadOrder: minimumLoadOrder,
      hiddenManagedParentCount: classification.hiddenManagedParentCount,
      hiddenManagedChildCount: classification.hiddenManagedChildCount,
      hiddenSystemChildCount: classification.hiddenSystemChildCount,
      cycleCount: cycles.length,
      cycles: cycles.map((c) => ({
        objects: c.objects,
        breakEdge: c.breakEdge,
      })),
    },
    nextAction: "select",
    guidance:
      `Must-include parents (non-negotiable): ${arrOrNone(classification.mustIncludeParents)}. ` +
      `Optional parents (${classification.optionalParents.length}): ${arrOrNone(classification.optionalParents)}. ` +
      `Optional children (${classification.optionalChildren.length}): ${arrOrNone(classification.optionalChildren)}.` +
      hiddenHint +
      ` Ask the user which optional parents and children to include, then call ` +
      `sandbox_seed_seed with action: "select".`,
  };
}

// ────────────────────────────────────────────────────────────────────
// select
// ────────────────────────────────────────────────────────────────────

async function doSelect(
  args: SeedArgsT,
  store: SessionStore,
  overrides: SeedOverrides,
): Promise<SeedResponse> {
  const session = await loadSession(args, store);
  if (session.mustIncludeParents === undefined) {
    throw new UserError(
      `Session "${session.id}" has not been analyzed yet.`,
      `Call sandbox_seed_seed with action: "analyze" first.`,
    );
  }

  const chosenParents = args.includeOptionalParents ?? [];
  const chosenChildren = args.includeOptionalChildren ?? [];

  const optionalParentSet = new Set(session.optionalParents ?? []);
  const optionalChildSet = new Set(session.optionalChildren ?? []);
  const badParents = chosenParents.filter((p) => !optionalParentSet.has(p));
  const badChildren = chosenChildren.filter((c) => !optionalChildSet.has(c));
  if (badParents.length > 0 || badChildren.length > 0) {
    throw new UserError(
      `Unknown optional objects: parents=${badParents.join(",") || "-"}, children=${badChildren.join(",") || "-"}.`,
      `Pass names exactly as they appeared in the analyze response.`,
    );
  }

  const finalObjectList = [
    session.rootObject,
    ...(session.mustIncludeParents ?? []),
    ...chosenParents,
    ...chosenChildren,
  ].filter((v, i, a) => a.indexOf(v) === i);

  // Recompute a restricted load order. We re-run inspect to get the live
  // graph — describe cache makes this cheap.
  const sourceAuth = overrides.authBySource ?? (await resolveAuth(session.sourceOrg, API_VERSION));
  const result = await runInspect({
    auth: sourceAuth,
    rootObject: session.rootObject,
    parentWalkDepth: 2,
    includeChildren: true,
    includeCounts: false,
    cacheTtlSeconds: 86400,
    bypassCache: false,
    cacheRoot: overrides.cacheRoot,
    fetchFn: overrides.fetchFn,
  });
  const restrictedPlan = computeLoadOrder(result.graph, { requestedObjects: finalObjectList });
  const finalLoadOrder = loadOrderObjects(restrictedPlan.steps);

  session.selectedOptionalParents = chosenParents;
  session.selectedOptionalChildren = chosenChildren;
  session.finalObjectList = finalObjectList;
  session.finalLoadOrder = finalLoadOrder;
  session.step = "selected";
  await store.save(session);

  return {
    sessionId: session.id,
    step: session.step,
    action: "select",
    summary: {
      finalObjectList,
      finalLoadOrder,
      excluded: restrictedPlan.excluded,
      cycleStepCount: restrictedPlan.steps.filter((s) => s.kind === "cycle").length,
    },
    nextAction: "dry_run",
    guidance:
      `Final load order (${finalObjectList.length} object(s)): ${finalLoadOrder.join(" → ")}. ` +
      `Next: call sandbox_seed_seed with action: "dry_run" — this is mandatory before you can run.`,
  };
}

// ────────────────────────────────────────────────────────────────────
// dry_run
// ────────────────────────────────────────────────────────────────────

async function doDryRun(
  args: SeedArgsT,
  store: SessionStore,
  overrides: SeedOverrides,
): Promise<SeedResponse> {
  const session = await loadSession(args, store);
  if (session.finalObjectList === undefined) {
    throw new UserError(
      `Session "${session.id}" has not reached the select step yet.`,
      `Call sandbox_seed_seed with action: "select" first.`,
    );
  }

  const sourceAuth = overrides.authBySource ?? (await resolveAuth(session.sourceOrg, API_VERSION));
  const targetAuth = overrides.authByTarget ?? (await resolveAuth(session.targetOrg, API_VERSION));

  const sourceCache = new DescribeCache({
    orgId: sourceAuth.orgId,
    ttlSeconds: 86400,
    cacheRoot: overrides.cacheRoot,
  });
  const targetCache = new DescribeCache({
    orgId: targetAuth.orgId,
    ttlSeconds: 86400,
    cacheRoot: overrides.cacheRoot,
  });
  const sourceDescribe = new DescribeClient({
    auth: sourceAuth,
    cache: sourceCache,
    fetchFn: overrides.fetchFn,
  });
  const targetDescribe = new DescribeClient({
    auth: targetAuth,
    cache: targetCache,
    fetchFn: overrides.fetchFn,
  });

  const inspectResult = await runInspect({
    auth: sourceAuth,
    rootObject: session.rootObject,
    parentWalkDepth: 2,
    includeChildren: true,
    includeCounts: false,
    cacheTtlSeconds: 86400,
    bypassCache: false,
    cacheRoot: overrides.cacheRoot,
    fetchFn: overrides.fetchFn,
  });

  const summary = await runDryRun({
    sourceAuth,
    targetAuth,
    sourceDescribe,
    targetDescribe,
    graph: inspectResult.graph,
    rootObject: session.rootObject,
    whereClause: session.whereClause,
    finalObjectList: session.finalObjectList,
    sessionDir: store.sessionDir(session.id),
    fetchFn: overrides.fetchFn,
  });

  // If this session opted into deactivating target-org validation rules
  // on run, preview which rules would be touched. Purely informational —
  // the actual flip happens inside runExecute.
  let vrPreview:
    | { count: number; rulesByObject: Record<string, string[]> }
    | undefined;
  if (session.disableValidationRulesOnRun === true) {
    try {
      const rules = await queryActiveValidationRules({
        auth: targetAuth,
        objects: Array.from(new Set(session.finalObjectList)),
        fetchFn: overrides.fetchFn,
      });
      const rulesByObject: Record<string, string[]> = {};
      for (const r of rules) {
        const bucket = rulesByObject[r.entityApiName] ?? [];
        bucket.push(r.validationName);
        rulesByObject[r.entityApiName] = bucket;
      }
      vrPreview = { count: rules.length, rulesByObject };
    } catch {
      // Preview is best-effort. Run will surface the real error if the
      // Tooling API is unreachable at that point too.
      vrPreview = { count: -1, rulesByObject: {} };
    }
  }

  session.dryRun = summary;
  session.step = "dry_run_complete";
  await store.save(session);

  // Schema drift is NOT a blocker — execute.ts auto-drops source-only
  // fields during run. We still surface the names so the user can decide
  // whether they care enough to deploy the missing fields first.
  //
  // Upsert decisions: summarize as two counts + per-object key names so
  // the LLM can relay "will UPSERT X objects on their ext-id, INSERT the
  // rest" without forwarding field-level ambiguity reasons into prompt
  // context. Full reasons live in the on-disk report.
  const upsertDecisions = summary.upsertDecisions ?? {};
  const upsertKeys: Record<string, string> = {};
  let upsertCount = 0;
  let insertCount = 0;
  for (const obj of session.finalObjectList) {
    const d = upsertDecisions[obj];
    if (d !== undefined && d.kind === "picked") {
      upsertKeys[obj] = d.field;
      upsertCount++;
    } else {
      insertCount++;
    }
  }

  const summaryOut: Record<string, unknown> = {
    totalRecords: summary.totalRecords,
    perObjectCounts: summary.perObjectCounts,
    schemaWarningCount: summary.targetSchemaIssues.length,
    schemaWarnings: summary.targetSchemaIssues,
    reportPath: summary.reportPath,
    completedAt: summary.completedAt,
    disableValidationRulesOnRun: session.disableValidationRulesOnRun === true,
    upsertObjectCount: upsertCount,
    insertObjectCount: insertCount,
    upsertKeys,
  };
  if (vrPreview !== undefined) {
    summaryOut.validationRulesToDisable = vrPreview;
  }

  const schemaSuffix =
    summary.targetSchemaIssues.length === 0
      ? ""
      : ` ${summary.targetSchemaIssues.length} source-only field(s) will be auto-skipped during run.`;
  const upsertSuffix =
    upsertCount === 0
      ? ` All ${insertCount} object(s) will use INSERT (no unambiguous external-id keys found).`
      : insertCount === 0
        ? ` All ${upsertCount} object(s) will use UPSERT on their external-id keys — safe for re-runs.`
        : ` ${upsertCount} object(s) will UPSERT on external-id keys; ${insertCount} will INSERT.`;
  const vrSuffix =
    vrPreview !== undefined
      ? vrPreview.count === -1
        ? ` Validation-rule preview failed — run will still attempt the flip.`
        : ` ${vrPreview.count} target-org validation rule(s) will be deactivated + reactivated around the insert phase (exactly these, no others).`
      : "";

  return {
    sessionId: session.id,
    step: session.step,
    action: "dry_run",
    summary: summaryOut,
    nextAction: "run",
    guidance:
      `Dry run complete. ${summary.totalRecords} record(s) total.${upsertSuffix}${schemaSuffix}${vrSuffix} ` +
      `Review ${summary.reportPath}. When the user confirms, call sandbox_seed_seed ` +
      `with action: "run", confirm: true.`,
  };
}

// ────────────────────────────────────────────────────────────────────
// run
// ────────────────────────────────────────────────────────────────────

async function doRun(
  args: SeedArgsT,
  store: SessionStore,
  overrides: SeedOverrides,
): Promise<SeedResponse> {
  if (args.confirm !== true) {
    throw new UserError(
      `action: "run" requires confirm: true.`,
      `The user must explicitly confirm the run.`,
    );
  }
  const session = await loadSession(args, store);
  if (!isDryRunFresh(session)) {
    const hours = Math.round(DRY_RUN_FRESHNESS_MS / 3_600_000);
    throw new UserError(
      `No fresh dry run on session "${session.id}" — one is mandatory within ${hours}h before run.`,
      `Call sandbox_seed_seed with action: "dry_run" first.`,
    );
  }
  if (session.finalObjectList === undefined || session.finalObjectList.length === 0) {
    throw new UserError(
      `Session "${session.id}" has no final object list.`,
      `Re-run action: "select".`,
    );
  }

  const sourceAuth = overrides.authBySource ?? (await resolveAuth(session.sourceOrg, API_VERSION));
  const targetAuth = overrides.authByTarget ?? (await resolveAuth(session.targetOrg, API_VERSION));

  const sourceCache = new DescribeCache({
    orgId: sourceAuth.orgId,
    ttlSeconds: 86400,
    cacheRoot: overrides.cacheRoot,
  });
  const targetCache = new DescribeCache({
    orgId: targetAuth.orgId,
    ttlSeconds: 86400,
    cacheRoot: overrides.cacheRoot,
  });
  const sourceDescribe = new DescribeClient({
    auth: sourceAuth,
    cache: sourceCache,
    fetchFn: overrides.fetchFn,
  });
  const targetDescribe = new DescribeClient({
    auth: targetAuth,
    cache: targetCache,
    fetchFn: overrides.fetchFn,
  });

  const inspectResult = await runInspect({
    auth: sourceAuth,
    rootObject: session.rootObject,
    parentWalkDepth: 2,
    includeChildren: true,
    includeCounts: false,
    cacheTtlSeconds: 86400,
    bypassCache: false,
    cacheRoot: overrides.cacheRoot,
    fetchFn: overrides.fetchFn,
  });
  const restrictedPlan = computeLoadOrder(inspectResult.graph, {
    requestedObjects: session.finalObjectList,
  });

  let executed;
  try {
    executed = await runExecute({
      sourceAuth,
      targetAuth,
      sourceDescribe,
      targetDescribe,
      graph: inspectResult.graph,
      rootObject: session.rootObject,
      whereClause: session.whereClause,
      finalObjectList: session.finalObjectList,
      loadPlan: restrictedPlan,
      sessionDir: store.sessionDir(session.id),
      fetchFn: overrides.fetchFn,
      disableValidationRules: session.disableValidationRulesOnRun === true,
      sessionId: session.id,
      targetOrgAlias: session.targetOrg,
      upsertDecisions: session.dryRun?.upsertDecisions,
    });
  } catch (err) {
    session.lastError = err instanceof Error ? err.message : String(err);
    session.step = "errored";
    await store.save(session);
    throw err;
  }

  session.executed = executed;
  session.step = "executed";
  await store.save(session);

  const totalInserted = Object.values(executed.insertedCounts).reduce((a, b) => a + b, 0);

  const summaryOut: Record<string, unknown> = {
    totalInserted,
    insertedCounts: executed.insertedCounts,
    errorCount: executed.errorCount,
    logPath: executed.logPath,
    idMapPath: executed.idMapPath,
    completedAt: executed.completedAt,
  };
  if (typeof executed.validationRulesTouched === "number") {
    summaryOut.validationRulesTouched = executed.validationRulesTouched;
  }
  if (executed.validationRulesReactivationFailed !== undefined) {
    summaryOut.validationRulesReactivationFailed =
      executed.validationRulesReactivationFailed;
  }

  const vrSuffix =
    executed.validationRulesReactivationFailed !== undefined &&
    executed.validationRulesReactivationFailed.length > 0
      ? ` ⚠ ${executed.validationRulesReactivationFailed.length} validation rule(s) FAILED to reactivate — ` +
        `run action: "recover_validation_rules" with sessionId: "${session.id}" before any other seed work.`
      : typeof executed.validationRulesTouched === "number" &&
          executed.validationRulesTouched > 0
        ? ` Deactivated + reactivated ${executed.validationRulesTouched} target-org validation rule(s).`
        : "";

  return {
    sessionId: session.id,
    step: session.step,
    action: "run",
    summary: summaryOut,
    nextAction: null,
    guidance:
      executed.errorCount === 0
        ? `Run complete. Inserted ${totalInserted} record(s) across ${Object.keys(executed.insertedCounts).length} object(s). ` +
          `Log: ${executed.logPath}. ID map: ${executed.idMapPath}.${vrSuffix}`
        : `Run complete with ${executed.errorCount} error(s). Inserted ${totalInserted} record(s). ` +
          `Review ${executed.logPath} for per-record failures.${vrSuffix}`,
  };
}

// ────────────────────────────────────────────────────────────────────
// recover_validation_rules
// ────────────────────────────────────────────────────────────────────

async function doRecoverValidationRules(
  args: SeedArgsT,
  store: SessionStore,
  overrides: SeedOverrides,
): Promise<SeedResponse> {
  const session = await loadSession(args, store);

  const targetAuth =
    overrides.authByTarget ?? (await resolveAuth(session.targetOrg, API_VERSION));

  const result = await reactivateFromSnapshot({
    auth: targetAuth,
    sessionDir: store.sessionDir(session.id),
    fetchFn: overrides.fetchFn,
  });

  // Session step is unchanged — recovery is orthogonal to the seed flow.
  return {
    sessionId: session.id,
    step: session.step,
    action: "recover_validation_rules",
    summary: {
      reactivatedCount: result.reactivatedCount,
      failedCount: result.failed.length,
      failedFullNames: result.failed.map((f) => f.fullName),
      totalInSnapshot: result.totalInSnapshot,
    },
    nextAction: result.failed.length === 0 ? null : "recover_validation_rules",
    guidance:
      result.totalInSnapshot === 0
        ? `No pending validation-rule recovery for session "${session.id}" — nothing to do.`
        : result.failed.length === 0
          ? `Recovered ${result.reactivatedCount} validation rule(s) on "${session.targetOrg}". ` +
            `Snapshot archived. You can resume seed work now.`
          : `Reactivated ${result.reactivatedCount}/${result.totalInSnapshot}. ` +
            `${result.failed.length} rule(s) FAILED: ${result.failed.map((f) => f.fullName).join(", ")}. ` +
            `Fix the target-org auth/permissions and retry action: "recover_validation_rules" with the same sessionId.`,
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function requireField(name: string, action: string): never {
  throw new UserError(
    `action: "${action}" requires \`${name}\`.`,
    `Supply ${name} and try again.`,
  );
}

async function loadSession(args: SeedArgsT, store: SessionStore): Promise<Session> {
  if (args.sessionId === undefined) {
    throw new UserError(
      `action: "${args.action}" requires \`sessionId\`.`,
      `Pass the sessionId returned by action: "start".`,
    );
  }
  return await store.load(args.sessionId);
}

function loadOrderObjects(
  steps: ReturnType<typeof computeLoadOrder>["steps"],
): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === "single") out.push(s.object);
    else for (const o of s.objects) out.push(o);
  }
  return out;
}

function arrOrNone(arr: string[]): string {
  return arr.length === 0 ? "(none)" : arr.join(", ");
}

async function checkIsSandbox(opts: {
  auth: OrgAuth;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  const soql = `SELECT IsSandbox FROM Organization LIMIT 1`;
  const url = `${opts.auth.instanceUrl}/services/data/v${opts.auth.apiVersion}/query?q=${encodeURIComponent(soql)}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${opts.auth.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new ApiError(
      `Could not verify target is a sandbox (HTTP ${res.status}).`,
      `Check target-org permissions.`,
    );
  }
  try {
    const body = (await res.json()) as {
      records?: Array<{ IsSandbox?: boolean }>;
    };
    const rec = body.records?.[0];
    return rec?.IsSandbox === true;
  } catch {
    return false;
  }
}

// Silence unused-import warnings for helpers consumed only inside dry-run /
// execute modules but imported here for type access in tests/future work.
export const _internal = { queryCount, queryIds };
